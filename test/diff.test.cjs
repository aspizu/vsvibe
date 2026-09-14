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
      showErrorMessage: (message) => assert.fail(message),
    },
    commands: {
      executeCommand: async (command, left, right, title, options) => {
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
  runInNewContext(`(function(require, module, exports) { ${readFileSync(path, "utf8")}\n})`)(
    (name) => (name === "vscode" ? vscode : originalRequire(name)),
    module,
    module.exports,
  );
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
    openingDiffs: new Map(),
  });
  return {
    view,
    calls,
    titles,
    group,
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
