const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { mkdtemp, rm } = require("node:fs/promises");
const { createRequire } = require("node:module");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");

function fixture(mode = "branch", status = "M") {
  const uri = (scheme, path, query = "") => ({
    toString: () => `${scheme}:${path}?${query}`,
    scheme,
    path,
  });
  const calls = [];
  const files = [];
  const titles = [];
  const updates = [];
  const previews = [];
  const group = { tabs: [] };
  const closed = [];
  const tabGroups = {
    activeTabGroup: group,
    all: [group],
    close: async (tabs) => {
      closed.push(...tabs);
      for (const group of tabGroups.all) {
        if (tabs.includes(group.activeTab)) group.activeTab = undefined;
        group.tabs = group.tabs.filter((tab) => !tabs.includes(tab));
      }
      return true;
    },
  };
  class TabInputTextDiff {
    constructor(original, modified) {
      this.original = original;
      this.modified = modified;
    }
  }
  class TabInputText {
    constructor(uri) {
      this.uri = uri;
    }
  }
  const vscode = {
    Uri: {
      from: ({ scheme, path, query }) => uri(scheme, path, query),
      file: (path) => uri("file", path),
      joinPath: (root, path) => uri(root.scheme, `${root.path}/${path}`),
    },
    TabInputTextDiff,
    TabInputText,
    FileChangeType: { Changed: 1 },
    FileType: { File: 1, Directory: 2 },
    FileSystemError: {
      FileNotFound: (uri) => new Error(`File not found: ${uri.toString()}`),
    },
    window: {
      tabGroups,
      withProgress: async (_options, task) => task(),
      showErrorMessage: (message) => assert.fail(message),
    },
    commands: {
      executeCommand: async (command, left, right, title, options) => {
        if (command === "diffEditor.showAllUnchangedRegions" || command === "setContext") return;
        if (command === "vscode.open") {
          assert.equal(right.preserveFocus, true);
          files.push(left.toString());
          previews.push(right.preview);
          group.activeTab = { input: new TabInputText(left) };
          group.tabs.push(group.activeTab);
          return;
        }
        assert.equal(command, "vscode.diff");
        assert.equal(options.preserveFocus, true);
        calls.push([left.toString(), right.toString()]);
        previews.push(options.preview);
        titles.push(title);
        group.activeTab = { input: new TabInputTextDiff(left, right) };
        group.tabs.push(group.activeTab);
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
    pendingPaths: new Set(),
    scheduleGeneration: 0,
    refreshRequested: false,
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
    snapshotChanged: { fire: (changes) => updates.push(changes[0].uri.toString()) },
    persistSnapshot() {},
    lastTurnEditors: new Map(),
    openingDiffs: new Map(),
  });
  return {
    view,
    calls,
    files,
    titles,
    group,
    updates,
    previews,
    closed,
    tabGroups,
    window: vscode.window,
    setIndex: (value) => {
      index = value;
    },
  };
}

test("virtual diff content survives a new extension instance", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "vsvibe-snapshots-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { view } = fixture();
  const uri = { query: "version", toString: () => "vsvibe-diff:/file.txt?version" };
  view.context = { globalStorageUri: { fsPath: directory } };
  delete view.persistSnapshot;
  view.persistSnapshot(uri, "saved diff\n");
  view.snapshots.clear();
  const reloaded = Object.create(Object.getPrototypeOf(view));
  reloaded.context = view.context;
  assert.equal(Buffer.from(await reloaded.readSnapshot(uri)).toString(), "saved diff\n");
  assert.equal((await reloaded.snapshotStat(uri)).size, Buffer.byteLength("saved diff\n"));
});

test("Review opens individual diffs as previews", async () => {
  const { view, previews } = fixture();
  await view.openDiff("file");
  assert.deepEqual(previews, [true]);
});

test("review finder searches scope paths and opens only the accepted item", async () => {
  const { view, window, calls } = fixture();
  const entry = view.entries.get("file");
  view.entries.set("second", {
    ...entry,
    path: "src/file.txt",
    originalPath: "src/file.txt",
    repository: { ...entry.repository, root: "/other" },
  });
  let accept;
  window.showQuickPick = (items, options) => {
    assert.equal(items.length, 2);
    assert.equal(items[0].label, "file.txt");
    assert.equal(items[1].label, "file.txt");
    assert.equal(items[0].description, "/repo · file.txt");
    assert.equal(items[1].description, "/other · src/file.txt");
    assert.equal(options.matchOnDescription, true);
    assert.equal(options.title, "Find Review File (Branch)");
    return new Promise((resolve) => {
      accept = () => resolve(items[1]);
    });
  };
  const finding = view.findFile();
  assert.equal(calls.length, 0);
  accept();
  await finding;
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], "file:/other/src/file.txt?");
});

test("canceling the finder opens nothing", async () => {
  const { view, window, calls, files } = fixture();
  window.showQuickPick = async () => undefined;
  await view.findFile();
  assert.equal(calls.length, 0);
  assert.equal(files.length, 0);
});

test("accepting an added file in the finder opens it directly", async () => {
  const { view, window, files } = fixture("branch", "A");
  window.showQuickPick = async (items) => items[0];
  await view.findFile();
  assert.deepEqual(files, ["file:/repo/file.txt?"]);
});

for (const status of ["M", "D", "R"]) {
  test(`clicking the active ${status} diff again does not reopen it`, async () => {
    const { view, calls } = fixture("branch", status);
    await view.openDiff("file");
    await view.openDiff("file");
    assert.equal(calls.length, 1);
  });
}

for (const mode of ["branch", "uncommitted", "unstaged", "lastTurn"]) {
  test(`added files in ${mode} open directly and reuse the active editor`, async () => {
    const { view, calls, files, previews } = fixture(mode, "A");
    await view.openDiff("file");
    await view.openDiff("file");
    assert.equal(calls.length, 0);
    assert.deepEqual(files, ["file:/repo/file.txt?"]);
    assert.deepEqual(previews, [true]);
    assert.equal(view.snapshots.size, 0);
  });
}

test("added staged files open index contents and update when the index changes", async () => {
  const { view, calls, files, setIndex } = fixture("staged", "A");
  await view.openDiff("file");
  await view.openDiff("file");
  assert.equal(files.length, 1);
  assert.ok(files[0].startsWith("vsvibe-diff:"));
  assert.deepEqual([...view.snapshots.values()], ["staged content"]);
  setIndex("updated staged content");
  await view.openDiff("file");
  assert.equal(calls.length, 0);
  assert.equal(files.length, 2);
  assert.notEqual(files[0], files[1]);
});

test("open all opens added files directly as kept-open editors", async () => {
  const { view, files, calls, previews } = fixture("branch", "A");
  await view.openAllDiffs();
  assert.deepEqual(files, ["file:/repo/file.txt?"]);
  assert.deepEqual(previews, [false]);
  assert.equal(calls.length, 0);
});

test("concurrent clicks share one pending diff open", async () => {
  const { view, calls } = fixture();
  await Promise.all([view.openDiff("file"), view.openDiff("file")]);
  assert.equal(calls.length, 1);
});

test("open all closes existing tabs and opens every diff kept-open", async () => {
  const { view, calls, previews, titles, closed, tabGroups } = fixture();
  const entry = view.entries.get("file");
  view.entries.set("second", { ...entry, path: "second.txt", originalPath: "second.txt" });
  view.entries.set("third", { ...entry, path: "third.txt", originalPath: "third.txt" });
  await view.openDiff("file");
  const previous = tabGroups.activeTabGroup.activeTab;
  const other = { input: {} };
  tabGroups.all.push({ tabs: [other] });
  await view.openAllDiffs();
  assert.deepEqual(closed, [previous, other]);
  assert.deepEqual(previews, [true, false, false, false]);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[0], calls[1]);
  assert.deepEqual(titles.slice(1), [
    "file.txt (Branch)",
    "second.txt (Branch)",
    "third.txt (Branch)",
  ]);
});

test("canceling tab closure stops open all", async () => {
  const { view, calls, tabGroups } = fixture();
  tabGroups.activeTabGroup.tabs.push({ input: {}, isDirty: false });
  tabGroups.close = async () => false;
  await view.openAllDiffs();
  assert.equal(calls.length, 0);
});

test("a slow diff does not delay opening the other diffs", async () => {
  const { view, titles } = fixture();
  const entry = view.entries.get("file");
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  view.entries.set("second", {
    ...entry,
    path: "second.txt",
    originalPath: "second.txt",
    repository: { ...entry.repository, content: async () => "original" },
  });
  entry.repository.content = () => pending;
  const opening = view.openAllDiffs();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(titles, ["second.txt (Branch)"]);
  finish("original");
  await opening;
  assert.deepEqual(titles, ["second.txt (Branch)", "file.txt (Branch)"]);
});

test("open all leaves unsaved editors open", async () => {
  const { view, closed, tabGroups, previews } = fixture();
  const dirty = { input: {}, isDirty: true };
  const clean = { input: {}, isDirty: false };
  tabGroups.activeTabGroup.tabs.push(dirty, clean);
  await view.openAllDiffs();
  assert.deepEqual(closed, [clean]);
  assert.ok(tabGroups.activeTabGroup.tabs.includes(dirty));
  assert.deepEqual(previews, [false]);
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

test("an immediate refresh cancels the queued automatic refresh", async () => {
  const { view } = fixture();
  let refreshes = 0;
  Object.assign(view, {
    git: {},
    generation: 0,
    view: { selection: [], visible: true },
    loadChanges: async () => refreshes++,
  });
  view.schedule();
  await view.refresh();
  assert.equal(refreshes, 1);
  assert.equal(view.timer, undefined);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(refreshes, 1);
});

test("watcher batches skip ignored paths and Git events bypass ignore filtering", async () => {
  const { view } = fixture();
  let refreshes = 0;
  const batches = [];
  view.refresh = async () => refreshes++;
  view.hasRelevantChanges = async (paths) => {
    batches.push(Array.from(paths));
    return paths.includes("/repo/new.ts");
  };
  view.schedule("/repo/output.log");
  view.schedule("/repo/output.log");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(refreshes, 0);
  assert.deepEqual(batches, [["/repo/output.log"]]);
  view.schedule("/repo/output.log");
  view.schedule("/repo/new.ts");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(refreshes, 1);
  view.schedule("/repo/output.log");
  view.schedule();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(refreshes, 2);
  assert.equal(batches.length, 2);
});

test("ignore check failures still refresh", async () => {
  const { view } = fixture();
  let refreshes = 0;
  view.refresh = async () => refreshes++;
  view.hasRelevantChanges = async () => {
    throw new Error("Git unavailable");
  };
  view.pendingPaths.add("/repo/file.txt");
  await view.refreshScheduled(view.scheduleGeneration);
  assert.equal(refreshes, 1);
});

test("refresh retains rows and decorations until replacement data is published", async () => {
  const { view } = fixture();
  const entries = view.entries;
  const tree = [...entries.values()];
  let changes = 0;
  let decorations = 0;
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const next = new Map();
  Object.assign(view, {
    git: {},
    generation: 0,
    layout: "tree",
    tree,
    view: { selection: [], visible: true, message: "Previous message" },
    changed: { fire: () => changes++ },
    decorationsChanged: { fire: () => decorations++ },
    loadChanges: async (generation) => {
      await pending;
      await view.publishChanges(generation, next, []);
    },
  });
  const refresh = view.refresh();
  await Promise.resolve();
  assert.equal(view.entries, entries);
  assert.equal(view.entries.size, 1);
  assert.equal(view.getChildren(), tree);
  assert.equal(view.view.message, "Previous message");
  assert.equal(changes, 0);
  assert.equal(decorations, 0);
  finish();
  await refresh;
  assert.equal(view.entries, next);
  assert.equal(view.getChildren().length, 0);
  assert.equal(view.view.message, "");
  assert.equal(changes, 1);
  assert.equal(decorations, 1);
});

test("disposed views do not queue automatic refreshes", () => {
  const { view } = fixture();
  view.disposed = true;
  view.schedule();
  assert.equal(view.timer, undefined);
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
