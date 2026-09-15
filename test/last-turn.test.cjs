const assert = require("node:assert/strict");
const { test } = require("node:test");
const { mkdtemp, mkdir, writeFile, rm, utimes } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { LastTurnReader, reconstructPatches } = require("../dist/last-turn.js");

const update = (unified_diff, move_path = null) => ({ type: "update", unified_diff, move_path });
const event = (type, rest = {}) => ({ type: "event_msg", payload: { type, ...rest } });
const start = (turn_id) => event("task_started", { turn_id });
const complete = (turn_id) => event("task_complete", { turn_id });
const patch = (turn_id, changes, id = "patch") =>
  event("item_completed", {
    turn_id,
    item: { type: "FileChange", status: "completed", id, changes },
  });

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "vsvibe-turn-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const sessions = join(root, "sessions");
  await mkdir(workspace);
  await mkdir(sessions);
  return {
    workspace,
    sessions,
    async session(name, cwd, records, mtime = 1000) {
      const path = join(sessions, name + ".jsonl");
      await writeFile(
        path,
        [{ type: "session_meta", payload: { cwd } }, ...records].map(JSON.stringify).join("\n") +
          "\n",
      );
      await utimes(path, mtime, mtime);
      return path;
    },
  };
}

test("latest matching session uses its latest completed turn, ignoring an active turn", async (t) => {
  const f = await fixture(t);
  const changes = { "file.txt": { type: "add", content: "recorded\n" } };
  await f.session("older", f.workspace, [
    start("old"),
    patch("old", { "old.txt": { type: "add", content: "old" } }),
    complete("old"),
  ]);
  await f.session(
    "latest",
    f.workspace,
    [
      start("one"),
      patch("one", changes),
      complete("one"),
      start("two"),
      patch("two", { "active.txt": { type: "add", content: "active" } }),
    ],
    2000,
  );
  await f.session(
    "unrelated",
    join(f.workspace, "child"),
    [start("other"), complete("other")],
    3000,
  );
  const result = await new LastTurnReader().read(f.workspace, f.sessions);
  assert.deepEqual(
    result.files.map(({ path, before, after }) => ({ path, before, after })),
    [{ path: "file.txt", before: "", after: "recorded\n" }],
  );
});

test("does not fall back to an older turn when the latest has no patches", async (t) => {
  const f = await fixture(t);
  await f.session("session", f.workspace, [
    start("one"),
    patch("one", { "old.txt": { type: "add", content: "old" } }),
    complete("one"),
    start("two"),
    complete("two"),
  ]);
  const result = await new LastTurnReader().read(f.workspace, f.sessions);
  assert.equal(result.files.length, 0);
  assert.deepEqual(result, { files: [] });
});

test("successful patch_apply_end is read and failed changes are excluded", async (t) => {
  const f = await fixture(t);
  await f.session("session", f.workspace, [
    start("one"),
    event("patch_apply_end", { success: false, changes: { bad: { type: "add", content: "bad" } } }),
    event("patch_apply_end", {
      success: true,
      call_id: "ok",
      changes: { ok: { type: "add", content: "yes" } },
    }),
    complete("one"),
  ]);
  assert.deepEqual(
    (await new LastTurnReader().read(f.workspace, f.sessions)).files.map((file) => file.path),
    ["ok"],
  );
});

test("repeated edits reconstruct the net recorded change without reading current files", () => {
  const files = reconstructPatches(
    [
      { "src/file.ts": update("@@ -2,2 +2,2 @@\n context\n-before\n+middle\n") },
      { "src/file.ts": update("@@ -2,2 +2,2 @@\n context\n-middle\n+after\n") },
    ],
    "/repo",
  );
  assert.equal(
    files[0].before,
    "⋯ unchanged lines omitted ⋯\ncontext\nbefore\n⋯ unchanged lines omitted ⋯\n",
  );
  assert.equal(
    files[0].after,
    "⋯ unchanged lines omitted ⋯\ncontext\nafter\n⋯ unchanged lines omitted ⋯\n",
  );
});

test("supports additions, deletions, renames and no-final-newline patches", () => {
  const files = reconstructPatches(
    [
      {
        "added.txt": { type: "add", content: "new\n" },
        "deleted.txt": { type: "delete", content: "old\n" },
        "old.txt": update(
          "@@ -1 +1 @@\n-before\n\\ No newline at end of file\n+after\n\\ No newline at end of file\n",
          "new.txt",
        ),
      },
    ],
    "/repo",
  );
  assert.deepEqual(
    files.map((file) => [file.path, file.status]),
    [
      ["added.txt", "A"],
      ["deleted.txt", "D"],
      ["new.txt", "R"],
    ],
  );
  assert.equal(files[1].before, "old\n");
  assert.equal(files[1].after, "");
  assert.equal(files[2].before, "before");
  assert.equal(files[2].after, "after");
});

test("added then modified yields one addition; added then deleted disappears", () => {
  const add = { file: { type: "add", content: "first\n" } };
  const edit = { file: update("@@ -1 +1 @@\n-first\n+second\n") };
  assert.equal(reconstructPatches([add, edit], "/repo")[0].after, "second\n");
  assert.equal(
    reconstructPatches([add, { file: { type: "delete", content: "first\n" } }], "/repo").length,
    0,
  );
});

test("rejects incomplete patches, conflicting edits and paths outside the workspace", () => {
  assert.throws(() =>
    reconstructPatches([{ file: update("@@ -1,2 +1 @@\n-old\n+new\n") }], "/repo"),
  );
  assert.throws(() =>
    reconstructPatches([{ "../outside": { type: "add", content: "x" } }], "/repo"),
  );
  assert.throws(() =>
    reconstructPatches(
      [
        { file: { type: "add", content: "first\n" } },
        { file: update("@@ -1 +1 @@\n-wrong\n+new\n") },
      ],
      "/repo",
    ),
  );
});

test("missing sessions and incomplete trailing JSON are handled", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await new LastTurnReader().read(f.workspace, join(f.sessions, "missing")), {
    files: [],
  });
  const path = await f.session("session", f.workspace, [start("one"), complete("one")]);
  const { appendFile } = require("node:fs/promises");
  await appendFile(path, '{"type":');
  assert.deepEqual(await new LastTurnReader().read(f.workspace, f.sessions), { files: [] });
});
