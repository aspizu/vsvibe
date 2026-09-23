const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { mkdtemp, mkdir, realpath, rm } = require("node:fs/promises");
const { createRequire } = require("node:module");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");
const { chatWorkspace } = require("../dist/t3-workspace.js");
const { savedSidebarView } = require("../dist/sidebar-state.js");

test("T3 chat state chooses the worktree, then the project root", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "vsvibe-t3-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "state.sqlite");
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE projection_projects (project_id TEXT, workspace_root TEXT, deleted_at TEXT);
    CREATE TABLE projection_threads (thread_id TEXT, project_id TEXT, worktree_path TEXT, deleted_at TEXT);
    INSERT INTO projection_projects VALUES ('project', '/repo', NULL);
    INSERT INTO projection_threads VALUES ('worktree', 'project', '/repo/tree', NULL);
    INSERT INTO projection_threads VALUES ('root', 'project', NULL, NULL);
    INSERT INTO projection_threads VALUES ('deleted', 'project', '/repo/old', 'now');
  `);
  database.close();
  assert.equal(chatWorkspace("worktree", path), "/repo/tree");
  assert.equal(chatWorkspace("root", path), "/repo");
  assert.equal(chatWorkspace("deleted", path), undefined);
});

function followerFixture(root, state = new Map(), storageUri) {
  const opened = [];
  const views = [];
  let workspaceListener;
  const vscode = {
    workspace: {
      workspaceFolders: [{ uri: { scheme: "file", fsPath: root } }],
      onDidChangeWorkspaceFolders(callback) {
        workspaceListener = callback;
        return { dispose() {} };
      },
    },
    Uri: { file: (fsPath) => ({ fsPath }) },
    commands: {
      executeCommand: async (name, uri, options) => {
        if (name.startsWith("workbench.view.")) {
          views.push(name);
          return;
        }
        assert.equal(name, "vscode.openFolder");
        assert.equal(options.forceReuseWindow, true);
        opened.push(uri.fsPath);
      },
    },
  };
  const path = resolve(__dirname, "../dist/workspace-follow.js");
  const originalRequire = createRequire(path);
  const module = { exports: {} };
  runInNewContext(`(function(require, module, exports) { ${readFileSync(path, "utf8")}\n})`)(
    (name) => (name === "vscode" ? vscode : originalRequire(name)),
    module,
    module.exports,
  );
  let listener;
  const chat = {
    id: "first",
    onDidChange(callback) {
      listener = callback;
      return { dispose() {} };
    },
    change(id) {
      this.id = id;
      listener(id);
    },
  };
  const context = {
    storageUri,
    globalState: {
      get: (key) => state.get(key),
      update: async (key, value) => {
        if (value === undefined) state.delete(key);
        else state.set(key, value);
      },
    },
  };
  return {
    WorkspaceFollow: module.exports.WorkspaceFollow,
    chat,
    context,
    opened,
    views,
    vscode,
    changeWorkspace(path) {
      vscode.workspace.workspaceFolders = [{ uri: { scheme: "file", fsPath: path } }];
      workspaceListener();
    },
  };
}

test("chat changes to the same workspace open it only once", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "vsvibe-same-workspace-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "source");
  const target = join(directory, "target");
  await Promise.all([mkdir(source), mkdir(target)]);
  const fixture = followerFixture(source);
  let started;
  let release;
  const opening = new Promise((resolve) => (started = resolve));
  const blocked = new Promise((resolve) => (release = resolve));
  const executeCommand = fixture.vscode.commands.executeCommand;
  fixture.vscode.commands.executeCommand = async (...args) => {
    await executeCommand(...args);
    if (args[0] === "vscode.openFolder") {
      started();
      await blocked;
    }
  };
  const paths = { first: source, second: target, third: target };
  const follower = new fixture.WorkspaceFollow(fixture.chat, fixture.context, (id) => paths[id]);
  t.after(() => follower.dispose());

  fixture.chat.change("second");
  await opening;
  fixture.chat.change("third");
  release();
  await new Promise((done) => setTimeout(done, 40));
  assert.deepEqual(fixture.opened, [await realpath(target)]);
});

test("later chat events wait for a requested workspace to change", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "vsvibe-requested-workspace-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "source");
  const target = join(directory, "target");
  await Promise.all([mkdir(source), mkdir(target)]);
  const fixture = followerFixture(source);
  const paths = { first: source, second: target, third: target };
  const follower = new fixture.WorkspaceFollow(fixture.chat, fixture.context, (id) => paths[id]);
  t.after(() => follower.dispose());

  fixture.chat.change("second");
  await new Promise((done) => setTimeout(done, 40));
  fixture.chat.change("third");
  await new Promise((done) => setTimeout(done, 40));
  assert.deepEqual(fixture.opened, [await realpath(target)]);

  fixture.changeWorkspace(target);
  fixture.changeWorkspace(source);
  fixture.chat.change("second");
  await new Promise((done) => setTimeout(done, 40));
  assert.deepEqual(fixture.opened, [await realpath(target), await realpath(target)]);
});

test("workspace handoff restores the target's saved activity bar tab", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "vsvibe-sidebar-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "source");
  const target = join(directory, "target");
  const storage = join(directory, "workspaceStorage", "target-id");
  await Promise.all([mkdir(source), mkdir(target), mkdir(storage, { recursive: true })]);
  await require("node:fs/promises").writeFile(
    join(storage, "workspace.json"),
    JSON.stringify({ folder: require("node:url").pathToFileURL(target).href }),
  );
  const database = new DatabaseSync(join(storage, "state.vscdb"));
  database.exec("CREATE TABLE ItemTable (key TEXT, value TEXT)");
  database
    .prepare("INSERT INTO ItemTable VALUES (?, ?)")
    .run("workbench.sidebar.activeviewletid", "workbench.view.extension.vsvibe");
  database.close();
  const storageUri = { scheme: "file", fsPath: join(storage, "extension") };
  assert.equal(
    await savedSidebarView(storageUri, await realpath(target)),
    "workbench.view.extension.vsvibe",
  );

  const globalState = new Map();
  const first = followerFixture(source, globalState, storageUri);
  const follower = new first.WorkspaceFollow(first.chat, first.context, () => target);
  t.after(() => follower.dispose());
  await new Promise((done) => setTimeout(done, 40));
  assert.deepEqual(first.opened, [await realpath(target)]);

  const second = followerFixture(target, globalState, storageUri);
  const resumed = new second.WorkspaceFollow(second.chat, second.context, () => target);
  t.after(() => resumed.dispose());
  await new Promise((done) => setTimeout(done, 40));
  assert.deepEqual(second.views, ["workbench.view.extension.vsvibe"]);
});

test("a window in any workspace follows the latest polled chat", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "vsvibe-follow-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const paths = Object.fromEntries(
    await Promise.all(
      ["first", "second", "third", "unrelated"].map(async (name) => {
        const path = join(directory, name);
        await mkdir(path);
        return [name, path];
      }),
    ),
  );
  const resolveWorkspace = (id) => paths[id];
  const other = followerFixture(paths.unrelated);
  const otherFollower = new other.WorkspaceFollow(other.chat, other.context, resolveWorkspace);
  t.after(() => otherFollower.dispose());
  await new Promise((done) => setTimeout(done, 60));
  assert.deepEqual(other.opened, [await realpath(paths.first)]);
  other.chat.change("second");
  other.chat.change("third");
  await new Promise((done) => setTimeout(done, 80));
  assert.deepEqual(other.opened, [await realpath(paths.first), await realpath(paths.third)]);
  otherFollower.dispose();
  const resumed = followerFixture(paths.third);
  resumed.chat.id = "second";
  const resumedFollower = new resumed.WorkspaceFollow(
    resumed.chat,
    resumed.context,
    resolveWorkspace,
  );
  t.after(() => resumedFollower.dispose());
  await new Promise((done) => setTimeout(done, 80));
  assert.deepEqual(resumed.opened, [await realpath(paths.second)]);
});

test("a chat change during a workspace handoff opens the latest workspace", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "vsvibe-switch-race-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const paths = Object.fromEntries(
    await Promise.all(
      ["first", "second", "third"].map(async (name) => {
        const path = join(directory, name);
        await mkdir(path);
        return [name, path];
      }),
    ),
  );
  const fixture = followerFixture(paths.first);
  const secondPath = await realpath(paths.second);
  let handoffStarted;
  let releaseHandoff;
  const started = new Promise((resolve) => (handoffStarted = resolve));
  const blocked = new Promise((resolve) => (releaseHandoff = resolve));
  const update = fixture.context.globalState.update;
  fixture.context.globalState.update = async (key, value) => {
    if (value?.path === secondPath) {
      handoffStarted();
      await blocked;
    }
    await update(key, value);
  };
  const follower = new fixture.WorkspaceFollow(fixture.chat, fixture.context, (id) => paths[id]);
  t.after(() => follower.dispose());
  fixture.chat.change("second");
  await started;
  fixture.chat.change("third");
  releaseHandoff();
  await new Promise((done) => setTimeout(done, 40));
  assert.deepEqual(fixture.opened, [await realpath(paths.third)]);
});

test("a project root follows after a window reload", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "vsvibe-handoff-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const paths = Object.fromEntries(
    await Promise.all(
      ["worktree", "root", "next"].map(async (name) => {
        const path = join(directory, name);
        await mkdir(path);
        return [name, path];
      }),
    ),
  );
  const globalState = new Map();
  const resolveWorkspace = (id) => paths[id];
  const worktree = followerFixture(paths.worktree, globalState);
  const first = new worktree.WorkspaceFollow(worktree.chat, worktree.context, resolveWorkspace);
  t.after(() => first.dispose());
  await new Promise((done) => setTimeout(done, 40));
  worktree.chat.change("root");
  await new Promise((done) => setTimeout(done, 40));
  assert.deepEqual(worktree.opened, [await realpath(paths.root)]);

  const root = followerFixture(paths.root, globalState);
  root.chat.id = "root";
  const second = new root.WorkspaceFollow(root.chat, root.context, resolveWorkspace);
  t.after(() => second.dispose());
  await new Promise((done) => setTimeout(done, 40));
  assert.equal(globalState.has("activeChat.workspaceHandoff"), false);
  second.dispose();

  const reloaded = followerFixture(paths.root, globalState);
  reloaded.chat.id = "root";
  const third = new reloaded.WorkspaceFollow(reloaded.chat, reloaded.context, resolveWorkspace);
  t.after(() => third.dispose());
  reloaded.chat.change("next");
  await new Promise((done) => setTimeout(done, 40));
  assert.deepEqual(reloaded.opened, [await realpath(paths.next)]);
});
