import { createReadStream } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import type { Change } from "./git";

export const sessionsDirectory = join(
  process.env.CODEX_HOME || join(homedir(), ".codex"),
  "sessions",
);
export interface RecordedChange extends Change {
  before: string;
  after: string;
}
interface RecordValue {
  type?: string;
  payload?: Record<string, unknown>;
}
interface Turn {
  id: string;
  patches: Map<string, unknown>;
  seen: Set<string>;
}
interface Line {
  text: string | undefined;
}
interface Document {
  originalPath: string;
  original: Line[];
  current: Line[];
  partial: boolean;
  added: boolean;
  deleted: boolean;
}

async function* records(path: string): AsyncGenerator<RecordValue> {
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      try {
        yield JSON.parse(line) as RecordValue;
      } catch {
        /* An append may be incomplete. */
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

async function canonical(path: string): Promise<string> {
  return realpath(path).catch(() => resolve(path));
}

export class LastTurnReader {
  private readonly metadata = new Map<string, { size: number; mtime: number; cwd: string }>();
  private readonly completed = new Map<string, { id: string; files: RecordedChange[] }>();

  async read(
    workspace: string,
    directory = sessionsDirectory,
  ): Promise<{ files: RecordedChange[] }> {
    const root = await canonical(workspace);
    const candidates: Array<{ path: string; mtime: number }> = [];
    const walk = async (path: string): Promise<void> => {
      let children;
      try {
        children = await readdir(path, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      for (const child of children) {
        const file = join(path, child.name);
        if (child.isDirectory()) await walk(file);
        else if (child.isFile() && child.name.endsWith(".jsonl")) {
          const info = await stat(file);
          candidates.push({ path: file, mtime: info.mtimeMs });
        }
      }
    };
    await walk(directory);
    candidates.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));
    for (const candidate of candidates) {
      const info = await stat(candidate.path);
      let meta = this.metadata.get(candidate.path);
      if (!meta || meta.size !== info.size || meta.mtime !== info.mtimeMs) {
        let cwd = "";
        for await (const record of records(candidate.path)) {
          if (record.type === "session_meta" && typeof record.payload?.cwd === "string") {
            cwd = await canonical(record.payload.cwd);
          }
          break;
        }
        meta = { size: info.size, mtime: info.mtimeMs, cwd };
        this.metadata.set(candidate.path, meta);
      }
      if (meta.cwd !== root) continue;
      const turn = await readTurn(candidate.path);
      if (!turn) continue;
      const cached = this.completed.get(candidate.path);
      if (cached?.id === turn.id) return { files: cached.files };
      if (!turn.patches.size) {
        this.completed.set(candidate.path, { id: turn.id, files: [] });
        return { files: [] };
      }
      try {
        const contents = new Map<string, string>();
        for (const group of turn.patches.values()) {
          for (const [path, value] of Object.entries(
            group as Record<string, Record<string, unknown>>,
          )) {
            const destination = safePath(
              root,
              typeof value.move_path === "string" ? value.move_path : path,
            );
            if (contents.has(destination)) continue;
            try {
              contents.set(destination, await readFile(join(root, destination), "utf8"));
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
          }
        }
        const files = reconstructPatches([...turn.patches.values()], root, contents);
        this.completed.set(candidate.path, { id: turn.id, files });
        return { files };
      } catch (error) {
        throw new Error(`Could not reconstruct Last Turn from ${candidate.path}`, {
          cause: error,
        });
      }
    }
    return { files: [] };
  }
}

async function readTurn(path: string): Promise<Turn | undefined> {
  let active: Turn | undefined;
  let completed: Turn | undefined;
  for await (const record of records(path)) {
    const p = record.payload;
    if (!p) continue;
    if (record.type === "event_msg" && p.type === "task_started") {
      active = { id: String(p.turn_id), patches: new Map(), seen: new Set() };
    } else if (
      record.type === "turn_context" &&
      typeof p.turn_id === "string" &&
      active?.id !== p.turn_id
    ) {
      active = { id: p.turn_id, patches: new Map(), seen: new Set() };
    }
    if (!active || record.type !== "event_msg") continue;
    if (p.type === "task_complete" && (!p.turn_id || p.turn_id === active.id)) {
      completed = active;
      active = undefined;
      continue;
    }
    if (p.type === "turn_aborted") {
      active = undefined;
      continue;
    }
    let changes: unknown;
    let id: string | undefined;
    if (p.type === "item_completed" && (!p.turn_id || p.turn_id === active.id)) {
      const item = p.item as Record<string, unknown> | undefined;
      if (item?.type === "FileChange" && item.status === "completed") {
        changes = item.changes;
        id = typeof item.id === "string" ? item.id : undefined;
      }
    } else if (p.type === "patch_apply_end" && p.success === true) {
      changes = p.changes;
      id = typeof p.call_id === "string" ? p.call_id : undefined;
    }
    if (!changes || typeof changes !== "object" || Array.isArray(changes)) continue;
    if (id && active.seen.has(id)) continue;
    if (id) active.seen.add(id);
    active.patches.set(String(active.patches.size), changes);
  }
  return completed;
}

function safePath(root: string, path: string): string {
  const result = relative(root, resolve(root, path));
  if (!result || result === ".." || result.startsWith(`..${sep}`) || isAbsolute(result))
    throw new Error("Outside workspace");
  return result.split(sep).join("/");
}
function split(text: string): Line[] {
  return (text.match(/[^\n]*\n|[^\n]+$/g) ?? []).map((text) => ({ text }));
}
function render(lines: Line[], partial: boolean): string {
  let result = "";
  let omitted = false;
  for (const line of lines) {
    if (line.text === undefined) {
      if (!omitted) result += "⋯ unchanged lines omitted ⋯\n";
      omitted = true;
    } else {
      result += line.text;
      omitted = false;
    }
  }
  if (partial && !omitted) result += "⋯ unchanged lines omitted ⋯\n";
  return result;
}

export function reconstructPatches(
  groups: unknown[],
  root: string,
  contents?: Map<string, string>,
): RecordedChange[] {
  const documents = new Map<string, Document>();
  for (const group of groups) {
    for (const [rawPath, rawChange] of Object.entries(group as Record<string, unknown>)) {
      const change = rawChange as Record<string, unknown>;
      const path = safePath(root, rawPath);
      let doc = documents.get(path);
      if (!doc) {
        doc = {
          originalPath: path,
          original: [],
          current: [],
          partial: true,
          added: false,
          deleted: false,
        };
        documents.set(path, doc);
      }
      if (change.type === "add" && typeof change.content === "string") {
        if (!doc.deleted && (doc.original.length || doc.current.length))
          throw new Error("Conflicting addition");
        doc.added = doc.original.length === 0 && !doc.deleted;
        doc.deleted = false;
        doc.partial = false;
        doc.current = split(change.content);
      } else if (change.type === "delete" && typeof change.content === "string") {
        if (doc.current.length) {
          if (doc.partial) fill(doc, 0, split(change.content));
          if (render(doc.current, false) !== change.content)
            throw new Error("Conflicting deletion");
        } else {
          doc.original = split(change.content);
        }
        doc.current = [];
        doc.partial = false;
        doc.deleted = true;
      } else if (change.type === "update" && typeof change.unified_diff === "string") {
        if (doc.deleted) throw new Error("Update after deletion");
        applyDiff(doc, change.unified_diff);
        if (typeof change.move_path === "string") {
          const destination = safePath(root, change.move_path);
          if (destination !== path && documents.has(destination))
            throw new Error("Conflicting rename");
          documents.delete(path);
          documents.set(destination, doc);
        }
      } else throw new Error("Unsupported patch");
    }
  }
  return [...documents]
    .flatMap(([path, doc]) => {
      if (
        contents &&
        !doc.deleted &&
        (doc.partial || doc.current.some((line) => line.text === undefined))
      ) {
        const content = contents.get(path);
        if (content === undefined) throw new Error("Full file unavailable");
        const lines = split(content);
        if (lines.length < doc.current.length) throw new Error("File changed since turn");
        fill(doc, 0, lines);
        doc.partial = false;
      }
      if (contents && doc.original.some((line) => line.text === undefined))
        throw new Error("Original file incomplete");
      const before = doc.added ? "" : render(doc.original, doc.partial);
      const after = doc.deleted ? "" : render(doc.current, doc.partial);
      if (before === after && path === doc.originalPath) return [];
      return [
        {
          path,
          originalPath: doc.originalPath,
          status: doc.added ? "A" : doc.deleted ? "D" : path !== doc.originalPath ? "R" : "M",
          before,
          after,
        },
      ];
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

function fill(doc: Document, start: number, expected: Line[]): void {
  if (start + expected.length > 1_000_000) throw new Error("Patch too large");
  while (doc.current.length < start + expected.length) {
    if (!doc.partial) throw new Error("Patch outside file");
    const line: Line = { text: undefined };
    doc.original.push(line);
    doc.current.push(line);
  }
  expected.forEach((line, index) => {
    const current = doc.current[start + index]!;
    if (current.text !== undefined && current.text !== line.text)
      throw new Error("Patch context mismatch");
    current.text = line.text;
  });
}

function applyDiff(doc: Document, diff: string): void {
  const lines = diff.split("\n");
  let offset = 0;
  let hunks = 0;
  for (let i = 0; i < lines.length; i++) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i]!);
    if (!match) continue;
    hunks++;
    const oldCount = Number(match[2] ?? 1);
    const newCount = Number(match[4] ?? 1);
    const start = Number(match[1]) - (oldCount ? 1 : 0) + offset;
    if (start < 0) throw new Error("Invalid hunk");
    const before: Line[] = [],
      after: Line[] = [];
    let last: Line[] = [];
    let reachesEnd = false;
    while (++i < lines.length && !lines[i]!.startsWith("@@")) {
      const line = lines[i]!;
      if (line === "\\ No newline at end of file") {
        reachesEnd = true;
        for (const value of last) value.text = value.text!.replace(/\n$/, "");
        continue;
      }
      const value = { text: line.slice(1) + "\n" };
      if (line.startsWith(" ")) {
        before.push(value);
        after.push(value);
        last = [value];
      } else if (line.startsWith("-")) {
        before.push(value);
        last = [value];
      } else if (line.startsWith("+")) {
        after.push(value);
        last = [value];
      } else if (line !== "") throw new Error("Invalid diff line");
    }
    i--;
    if (before.length !== oldCount || after.length !== newCount) throw new Error("Incomplete hunk");
    fill(doc, start, before);
    doc.current.splice(start, oldCount, ...after);
    if (reachesEnd) doc.partial = false;
    offset += newCount - oldCount;
  }
  if (!hunks && diff.trim()) throw new Error("No unified hunks");
}
