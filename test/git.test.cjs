const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, dirname } = require("node:path");
const { test } = require("node:test");
const { Repository } = require("../dist/git.js");

function fixture(t, initial = true) {
  const root = mkdtempSync(join(tmpdir(), "vsvibe-git-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const write = (path, content) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  const commit = () => {
    git("add", ".");
    git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture");
  };
  git("init", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  git("config", "commit.gpgsign", "false");
  if (initial) {
    write("modified.txt", "original\n");
    write("deleted.txt", "delete me\n");
    write("rename me.txt", "rename me\n");
    write(".gitignore", "ignored/\n");
    commit();
  }
  return { root, git, write, commit, repo: new Repository(root) };
}

const statuses = (result) =>
  Object.fromEntries(result.files.map((file) => [file.path, file.status]));

test("uncommitted combines staged, unstaged, untracked, renamed and deleted files", async (t) => {
  const f = fixture(t);
  f.write("modified.txt", "staged\n");
  f.git("add", "modified.txt");
  f.write("modified.txt", "working\n");
  f.git("mv", "rename me.txt", "renamed.txt");
  rmSync(join(f.root, "deleted.txt"));
  f.write("nested/new ü\t\nfile.txt", "new\n");
  f.write("ignored/skip.txt", "ignored\n");
  const changes = await f.repo.changes("uncommitted");
  assert.deepEqual(statuses(changes), {
    "deleted.txt": "D",
    "modified.txt": "M",
    "nested/new ü\t\nfile.txt": "A",
    "renamed.txt": "R",
  });
  const renamed = changes.files.find((file) => file.status === "R");
  assert.equal(renamed.originalPath, "rename me.txt");
  assert.equal(await f.repo.content(changes.base, renamed.originalPath), "rename me\n");
  assert.equal(await f.repo.content(changes.base, "deleted.txt"), "delete me\n");
});

test("branch includes commits and local changes without unrelated default-branch changes", async (t) => {
  const f = fixture(t);
  const base = f.git("rev-parse", "HEAD");
  f.git("checkout", "-b", "feature");
  f.write("committed.txt", "feature\n");
  f.commit();
  f.git("checkout", "main");
  f.write("upstream-only.txt", "upstream\n");
  f.commit();
  f.git("checkout", "feature");
  f.write("modified.txt", "local\n");
  f.git("add", "modified.txt");
  f.write("untracked.txt", "local\n");
  const changes = await f.repo.changes("branch");
  assert.equal(changes.base, base);
  assert.deepEqual(statuses(changes), {
    "committed.txt": "A",
    "modified.txt": "M",
    "untracked.txt": "A",
  });
  assert.equal(
    (await f.repo.changes("uncommitted")).files.some((file) => file.path === "committed.txt"),
    false,
  );
});

test("default branch has no Branch entries but shows uncommitted entries", async (t) => {
  const f = fixture(t);
  f.write("modified.txt", "local\n");
  assert.match((await f.repo.changes("branch")).message, /default branch/);
  assert.deepEqual((await f.repo.changes("branch")).files, []);
  assert.equal((await f.repo.changes("uncommitted")).files.length, 1);
});

test("unborn repository lists staged and untracked files", async (t) => {
  const f = fixture(t, false);
  f.write("staged.txt", "staged\n");
  f.git("add", ".");
  f.write("untracked.txt", "untracked\n");
  assert.deepEqual(statuses(await f.repo.changes("uncommitted")), {
    "staged.txt": "A",
    "untracked.txt": "A",
  });
  assert.match((await f.repo.changes("branch")).message, /first commit/);
});

test("uses remote HEAD and supports a custom remote default ref", async (t) => {
  const f = fixture(t);
  f.git("branch", "-m", "trunk");
  f.git("update-ref", "refs/remotes/upstream/trunk", "HEAD");
  f.git("symbolic-ref", "refs/remotes/upstream/HEAD", "refs/remotes/upstream/trunk");
  assert.match((await f.repo.changes("branch")).message, /default branch/);
  assert.match((await f.repo.changes("branch", "upstream/trunk")).message, /default branch/);
  f.git("checkout", "-b", "feature");
  f.write("modified.txt", "feature\n");
  f.commit();
  assert.deepEqual(statuses(await f.repo.changes("branch")), { "modified.txt": "M" });
});

test("missing default branch and detached HEAD produce actionable states", async (t) => {
  const f = fixture(t);
  f.git("branch", "-m", "trunk");
  assert.match((await f.repo.changes("branch")).message, /Default branch not found/);
  await assert.rejects(f.repo.changes("branch", "missing"), /not found locally/);
  f.git("checkout", "--detach");
  assert.match((await f.repo.changes("branch")).message, /Check out a branch/);
});

test("restored staged deletion compares to its original base", async (t) => {
  const f = fixture(t);
  f.git("rm", "modified.txt");
  f.write("modified.txt", "restored differently\n");
  const result = await f.repo.changes("uncommitted");
  assert.deepEqual(statuses(result), { "modified.txt": "M" });
  assert.equal(await f.repo.content(result.base, "modified.txt"), "original\n");
});

test("merge conflicts are listed once and missing base files have empty content", async (t) => {
  const f = fixture(t);
  f.git("checkout", "-b", "feature");
  f.write("added.txt", "feature\n");
  f.commit();
  f.git("checkout", "main");
  f.write("added.txt", "main\n");
  f.commit();
  assert.throws(() => f.git("merge", "feature"));
  assert.deepEqual(statuses(await f.repo.changes("uncommitted")), { "added.txt": "U" });
  assert.equal(await f.repo.content(f.git("rev-parse", "HEAD~1"), "added.txt"), "");
});

test("working tree changes that undo a branch commit disappear from Branch", async (t) => {
  const f = fixture(t);
  f.git("checkout", "-b", "feature");
  f.write("modified.txt", "committed\n");
  f.commit();
  f.write("modified.txt", "original\n");
  assert.deepEqual((await f.repo.changes("branch")).files, []);
  assert.deepEqual(statuses(await f.repo.changes("uncommitted")), { "modified.txt": "M" });
});
