const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const { resolve } = require("node:path");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");

function fixture(mode = "branch", status = "M") {
  const uri = (scheme, path, query = "") => ({
    toString: () => `${scheme}:${path}?${query}`,
    scheme,
    path,
  });
  const calls = [];
  const titles = [];
  const updates = [];
  const group = {};
  class TabInputTextDiff {
    constructor(original, modified) {
      this.original = original;
      this.modified = modified;
    }
  }
  const vscode = {
    Uri: {
      from: ({ scheme, path, query }) => uri(scheme, path, query),
      file: (path) => uri("file", path),
      joinPath: (root, path) => uri(root.scheme, `${root.path}/${path}`),
    },
    TabInputTextDiff,
    window: {
      tabGroups: { activeTabGroup: group },
      withProgress: async (_options, task) => task(),
      showErrorMessage: (message) => assert.fail(message),
    },
    commands: {
      executeCommand: async (command, left, right, title, options) => {
        if (command === "diffEditor.showAllUnchangedRegions" || command === "setContext") return;
        assert.equal(command, "vscode.diff");
        assert.equal(options.preserveFocus, true);
        calls.push([left.toString(), right.toString()]);
        titles.push(title);
        group.activeTab = { input: new TabInputTextDiff(left, right) };
      },
    },
  };
  const path = resolve(__dirname, "../dist/view.js");
  const originalRequire = createRequire(path);
  const module = { exports: {} };
  runInNewContext(`(function(require, module, exports) { ${readFileSync(path, "utf8")}\n})`, {
    setTimeout,
    clearTimeout,
  })((name) => (name === "vscode" ? vscode : originalRequire(name)), module, module.exports);
  const view = Object.create(module.exports.ChangesView.prototype);
  let index = "staged content";
  Object.assign(view, {
    mode,
    entries: new Map([
      [
        "file",
        {
          repository: {
            root: "/repo",
            content: async () => "original",
            indexContent: async () => index,
          },
          base: "commit",
          path: "file.txt",
          originalPath: "file.txt",
          status,
          mode,
        },
      ],
    ]),
    snapshots: new Map(),
    snapshotChanged: { fire: (uri) => updates.push(uri.toString()) },
    lastTurnEditors: new Map(),
    openingDiffs: new Map(),
  });
  return {
    view,
    calls,
    titles,
    group,
    updates,
    setIndex: (value) => {
      index = value;
    },
  };
}

for (const status of ["A", "M", "D", "R"]) {
  test(`clicking the active ${status} diff again does not reopen it`, async () => {
    const { view, calls } = fixture("branch", status);
    await view.openDiff("file");
    await view.openDiff("file");
    assert.equal(calls.length, 1);
  });
}

test("concurrent clicks share one pending diff open", async () => {
  const { view, calls } = fixture();
  await Promise.all([view.openDiff("file"), view.openDiff("file")]);
  assert.equal(calls.length, 1);
});

test("returning from another tab reuses the same diff URIs", async () => {
  const { view, calls, group } = fixture();
  await view.openDiff("file");
  group.activeTab = { input: {} };
  await view.openDiff("file");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
});

test("changed staged content opens an updated diff", async () => {
  const { view, calls, setIndex } = fixture("staged");
  await view.openDiff("file");
  await view.openDiff("file");
  assert.equal(calls.length, 1);
  setIndex("new staged content");
  await view.openDiff("file");
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0][1], calls[1][1]);
});

test("nested and renamed files use only the destination filename in the tab title", async () => {
  const { view, titles } = fixture("branch", "R");
  Object.assign(view.entries.get("file"), {
    path: "src/components/new-name.ts",
    originalPath: "src/legacy/old-name.ts",
  });
  await view.openDiff("file");
  assert.equal(titles[0], "new-name.ts (Branch)");
});

test("Last Turn uses the real workspace file with a recorded baseline", async () => {
  const { view, calls, titles } = fixture("lastTurn", "M");
  const entry = view.entries.get("file");
  entry.recorded = { before: "before turn\n", after: "after turn\n" };
  entry.repository.content = async () => assert.fail("Last Turn must not read Git content");
  await view.openDiff("file");
  assert.equal(calls.length, 1);
  assert.ok(calls[0][0].startsWith("vsvibe-diff:"));
  assert.equal(calls[0][1], "file:/repo/file.txt?");
  assert.deepEqual([...view.snapshots.values()], ["before turn\n"]);
  assert.equal(titles[0], "file.txt (Last Turn)");
});

test("open Last Turn diffs refresh the baseline without replacing the working file", async () => {
  const { view, calls, updates } = fixture("lastTurn");
  const entry = view.entries.get("file");
  entry.recorded = { before: "original\n", after: "first\n" };
  await view.openDiff("file");
  updates.length = 0;
  entry.recorded = { before: "first\n", after: "second\n" };
  view.refreshLastTurnEditors(view.entries);
  assert.deepEqual(updates, [calls[0][0]]);
  assert.deepEqual([...view.snapshots.values()], ["first\n"]);
  assert.equal(calls[0][1], "file:/repo/file.txt?");
  await view.openDiff("file");
  assert.equal(calls.length, 1);
});

test("a file absent from the next turn uses its last recorded contents as the baseline", async () => {
  const { view } = fixture("lastTurn");
  view.entries.get("file").recorded = { before: "before\n", after: "full\nfile\n" };
  await view.openDiff("file");
  view.refreshLastTurnEditors(new Map());
  assert.deepEqual([...view.snapshots.values()], ["full\nfile\n"]);
});

test("refresh scheduling debounces repeated events", async () => {
  const { view } = fixture();
  let refreshes = 0;
  view.refresh = async () => {
    refreshes++;
  };
  view.schedule();
  view.schedule();
  view.schedule();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(refreshes, 1);
});

test("open Last Turn editors refresh when the sidebar is hidden or on a different scope", async () => {
  for (const mode of ["lastTurn", "branch"]) {
    const { view, calls } = fixture("lastTurn");
    const entry = view.entries.get("file");
    entry.recorded = { before: "old\n", after: "first\n" };
    await view.openDiff("file");
    const next = new Map([
      ["file", { ...entry, recorded: { before: "first\n", after: "second\n" } }],
    ]);
    Object.assign(view, {
      mode,
      generation: 0,
      view: { selection: [], visible: false },
      changed: { fire() {} },
      decorationsChanged: { fire() {} },
      loadLastTurn: async () => view.refreshLastTurnEditors(next),
      loadChanges: async () => view.refreshLastTurnEditors(next),
    });
    await view.refresh();
    assert.deepEqual([...view.snapshots.values()], ["first\n"], mode);
    assert.equal(calls.length, 1);
  }
});

test("deleted Last Turn files retain an empty virtual right side", async () => {
  const { view, calls } = fixture("lastTurn", "D");
  view.entries.get("file").recorded = { before: "deleted\n", after: "" };
  await view.openDiff("file");
  assert.ok(calls[0][1].startsWith("vsvibe-diff:"));
  assert.deepEqual([...view.snapshots.values()], ["deleted\n", ""]);
});
