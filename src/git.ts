import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const scopeLabels = {
  lastTurn: "Last Turn",
  uncommitted: "Uncommitted",
  unstaged: "Unstaged",
  staged: "Staged",
  branch: "Branch",
} as const;
export type Mode = keyof typeof scopeLabels;
export interface Change {
  path: string;
  originalPath: string;
  status: string;
}
export interface Changes {
  base: string | undefined;
  branch: string;
  message: string;
  files: Change[];
}

export class Repository {
  constructor(
    readonly root: string,
    private readonly executable = "git",
  ) {}

  async git(...args: string[]): Promise<string> {
    return this.runGit(args);
  }

  private async runGit(args: string[], input?: string): Promise<string> {
    const pending = exec(this.executable, ["--no-optional-locks", ...args], {
      cwd: this.root,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: 15_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_LITERAL_PATHSPECS: "1" },
    });
    pending.child.stdin?.end(input);
    const { stdout } = await pending;
    return stdout;
  }

  async ignoredPaths(paths: string[]): Promise<Set<string>> {
    if (!paths.length) return new Set();
    try {
      const output = await this.runGit(
        ["--no-literal-pathspecs", "check-ignore", "-z", "--stdin"],
        `${paths.join("\0")}\0`,
      );
      return new Set(output.split("\0").filter(Boolean));
    } catch (error) {
      if (isGitExit(error, 1)) return new Set();
      throw error;
    }
  }

  private async ref(name: string): Promise<string | undefined> {
    try {
      return (
        await this.git("rev-parse", "--verify", "--end-of-options", `${name}^{commit}`)
      ).trim();
    } catch (error) {
      if (isGitExit(error, 128)) return undefined;
      throw error;
    }
  }

  private async defaultBranch(
    override: string,
  ): Promise<{ name: string; commit: string } | undefined> {
    if (override) {
      const commit = await this.ref(override);
      if (!commit)
        throw new Error(
          `Default branch "${override}" was not found locally. Fetch it or update vsvibe.defaultBranch.`,
        );
      return {
        name: (
          await this.git(
            "rev-parse",
            "--symbolic-full-name",
            "--verify",
            "--end-of-options",
            override,
          )
        )
          .trim()
          .replace(/^refs\/heads\//, "")
          .replace(/^refs\/remotes\/[^/]+\//, ""),
        commit,
      };
    }
    // A remote's symbolic HEAD records its default branch without a network request.
    const refs = (await this.git("for-each-ref", "--format=%(refname) %(symref)", "refs/remotes"))
      .trim()
      .split("\n")
      .map((line) => line.split(" "));
    refs.sort(
      ([a = ""], [b = ""]) =>
        Number(b === "refs/remotes/origin/HEAD") - Number(a === "refs/remotes/origin/HEAD"),
    );
    for (const [head, target] of refs) {
      if (!head?.endsWith("/HEAD") || !target) continue;
      const commit = await this.ref(target);
      if (commit) return { name: target.replace(/^refs\/remotes\/[^/]+\//, ""), commit };
    }
    for (const name of ["main", "master"]) {
      const commit = await this.ref(`refs/heads/${name}`);
      if (commit) return { name, commit };
    }
    return undefined;
  }

  async changes(mode: Exclude<Mode, "lastTurn">, defaultBranch = ""): Promise<Changes> {
    const branch = (await this.git("branch", "--show-current")).trim();
    let base = mode === "unstaged" ? ":" : await this.ref("HEAD");
    if (mode === "branch" && base && branch) {
      const target = await this.defaultBranch(defaultBranch);
      // With no branch comparison available, keep HEAD as the local-change base.
      if (target && branch !== target.name) {
        base = (await this.git("merge-base", "HEAD", target.commit)).trim();
      }
    }

    const files = new Map<string, Change>();
    if (base || mode === "staged") {
      const fields = (
        await this.git(
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--name-status",
          "-z",
          "--find-renames",
          ...(mode === "staged" ? ["--cached"] : []),
          ...(mode === "unstaged" || !base ? [] : [base]),
          "--",
        )
      ).split("\0");
      for (let index = 0; index < fields.length - 1;) {
        const status = fields[index++]?.charAt(0) ?? "M";
        const originalPath = fields[index++];
        const path = status === "R" || status === "C" ? fields[index++] : originalPath;
        if (path && originalPath && !(mode === "staged" && status === "U"))
          files.set(path, { path, originalPath, status });
      }
    } else {
      // An unborn branch has no HEAD; every existing index entry is an addition.
      for (const path of (await this.git("ls-files", "--cached", "-z"))
        .split("\0")
        .filter(Boolean)) {
        if (await exists(join(this.root, path)))
          files.set(path, { path, originalPath: path, status: "A" });
      }
    }

    const status = (
      await this.git("status", "--porcelain=v1", "-z", "--untracked-files=all")
    ).split("\0");
    for (let index = 0; index < status.length - 1; index++) {
      const record = status[index];
      if (!record) continue;
      const code = record.slice(0, 2);
      const path = record.slice(3);
      if (/[RC]/.test(code)) index++;
      if (mode === "staged") continue;
      if (code === "??") {
        // A staged deletion restored on disk is untracked, but may exist in the base.
        const previous = files.get(path);
        files.set(path, { path, originalPath: path, status: previous?.status === "D" ? "M" : "A" });
      } else if (code.includes("U") || code === "AA" || code === "DD") {
        files.set(path, { path, originalPath: path, status: "U" });
      }
    }
    return {
      base,
      branch,
      message: "",
      files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
    };
  }

  async indexContent(path: string): Promise<string> {
    const entries = (await this.git("ls-files", "--stage", "-z", "--", path))
      .split("\0")
      .filter((entry) => entry.slice(entry.indexOf("\t") + 1) === path)
      .map((entry) => entry.slice(0, entry.indexOf("\t")).split(" "));
    // During a conflict there is no stage 0; stage 2 is the local side.
    const entry =
      entries.find((entry) => entry[2] === "0") ?? entries.find((entry) => entry[2] === "2");
    return entry?.[1] ? this.git("cat-file", "blob", entry[1]) : "";
  }

  async content(commit: string, path: string): Promise<string> {
    if (commit === ":") return this.indexContent(path);
    // Conflicts can introduce a file absent from the selected base.
    if (!(await this.git("ls-tree", "-z", commit, "--", path))) return "";
    return this.git("show", `${commit}:${path}`);
  }
}

function isGitExit(error: unknown, code: number): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
}
