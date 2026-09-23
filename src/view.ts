import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import * as vscode from "vscode";
import { LastTurnReader, sessionsDirectory, type RecordedChange } from "./last-turn";
import type { GitAPI } from "./git-api";
import { buildTree, compareStatus, type Folder, type Layout, type SortOrder } from "./tree";
import { Repository, scopeLabels, type Change, type Mode } from "./git";

const statusDetails: Record<string, { label: string; color: string }> = {
  A: { label: "Added", color: "addedResourceForeground" },
  M: { label: "Modified", color: "modifiedResourceForeground" },
  D: { label: "Deleted", color: "deletedResourceForeground" },
  R: { label: "Renamed", color: "renamedResourceForeground" },
  C: { label: "Copied", color: "renamedResourceForeground" },
  T: { label: "Type changed", color: "modifiedResourceForeground" },
  U: { label: "Conflicted", color: "conflictingResourceForeground" },
};

interface Entry extends Change {
  mode: Mode;
  recorded?: RecordedChange;
  repository: Repository;
  base: string | undefined;
}

interface TrackedDiff {
  id: string;
  mode: Mode;
  root: string;
  path: string;
  originalPath: string;
  left: vscode.Uri;
  right: vscode.Uri;
  struck: boolean;
}

type ReviewNode = Entry | Folder<Entry>;

function findEntry(
  entries: Map<string, Entry>,
  record: TrackedDiff,
): { id: string; entry: Entry } | undefined {
  const direct = entries.get(record.id);
  if (direct) return { id: record.id, entry: direct };
  // A renamed file keeps its review diff alive under the new path.
  for (const [id, candidate] of entries) {
    if (
      candidate.repository.root === record.root &&
      (candidate.originalPath === record.originalPath || candidate.originalPath === record.path)
    )
      return { id, entry: candidate };
  }
  return undefined;
}

export class ChangesView implements vscode.TreeDataProvider<ReviewNode>, vscode.Disposable {
  private readonly view: vscode.TreeView<ReviewNode>;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly decorationsChanged = new vscode.EventEmitter<undefined>();
  private mode: Mode;
  private layout: Layout;
  private sortOrder: SortOrder;
  private tree: ReviewNode[] = [];
  private git: GitAPI | undefined;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly repositories = new Map<string, vscode.Disposable>();
  private entries = new Map<string, Entry>();
  private readonly snapshots = new Map<string, string>();
  private readonly snapshotChanged = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  private readonly lastTurnEditors = new Map<
    string,
    { left: vscode.Uri; right: vscode.Uri; root: string; path: string; after: string }
  >();
  private readonly lastTurn = new LastTurnReader();
  private readonly openingDiffs = new Map<string, Promise<void>>();
  private readonly reviewDiffs = new Map<string, TrackedDiff>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly pendingPaths = new Set<string>();
  private refreshRequested = false;
  private scheduleGeneration = 0;
  private expandTimer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private selectedId: string | undefined;
  private disposed = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.sortOrder =
      context.workspaceState.get<SortOrder>("changes.sort") === "status" ? "status" : "name";
    void vscode.commands.executeCommand("setContext", "vsvibe.sort", this.sortOrder);
    this.layout = context.workspaceState.get<Layout>("changes.layout") === "tree" ? "tree" : "list";
    void vscode.commands.executeCommand("setContext", "vsvibe.layout", this.layout);
    const savedMode = context.workspaceState.get<Mode>("changes.mode");
    this.mode = savedMode && Object.hasOwn(scopeLabels, savedMode) ? savedMode : "branch";
    this.view = vscode.window.createTreeView("vsvibe.changes", {
      treeDataProvider: this,
      showCollapseAll: false,
    });
    this.view.title = this.modeLabel;
    void vscode.commands.executeCommand("setContext", "vsvibe.scope", this.mode);
    this.subscriptions.push(
      this.view,
      this.changed,
      this.snapshotChanged,
      this.decorationsChanged,
      vscode.window.registerFileDecorationProvider({
        onDidChangeFileDecorations: this.decorationsChanged.event,
        provideFileDecoration: (uri) => {
          if (uri.scheme !== "vsvibe-review") return undefined;
          const entry = this.entries.get(uri.with({ scheme: "file" }).toString());
          if (!entry) return undefined;
          const details = statusDetails[entry.status];
          return new vscode.FileDecoration(
            entry.status,
            details?.label ?? entry.status,
            details ? new vscode.ThemeColor(`gitDecoration.${details.color}`) : undefined,
          );
        },
      }),
      vscode.workspace.registerFileSystemProvider(
        "vsvibe-diff",
        {
          onDidChangeFile: this.snapshotChanged.event,
          watch: () => ({ dispose() {} }),
          stat: (uri) => this.snapshotStat(uri),
          readDirectory: () => [],
          readFile: (uri) => this.readSnapshot(uri),
          createDirectory: (uri) => {
            throw vscode.FileSystemError.NoPermissions(uri);
          },
          writeFile: (uri) => {
            throw vscode.FileSystemError.NoPermissions(uri);
          },
          delete: (uri) => {
            throw vscode.FileSystemError.NoPermissions(uri);
          },
          rename: (uri) => {
            throw vscode.FileSystemError.NoPermissions(uri);
          },
        },
        { isReadonly: true },
      ),
      vscode.workspace.onDidCloseTextDocument((document) => {
        this.snapshots.delete(document.uri.toString());
        for (const [id, editor] of this.lastTurnEditors) {
          if (
            !this.snapshots.has(editor.left.toString()) &&
            !this.snapshots.has(editor.right.toString())
          )
            this.lastTurnEditors.delete(id);
        }
      }),
      vscode.workspace.onDidChangeTextDocument(({ document }) => {
        if (
          document.uri.scheme === "vsvibe-diff" ||
          [...this.lastTurnEditors.values()].some(
            ({ right }) => right.toString() === document.uri.toString(),
          )
        )
          this.scheduleExpand();
      }),
      vscode.window.onDidChangeActiveTextEditor(() => this.scheduleExpand()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("vsvibe.defaultBranch")) this.schedule();
      }),
    );
    const watcher = vscode.workspace.createFileSystemWatcher("**/*");
    const changed = (uri: vscode.Uri) => {
      if (!uri.path.split("/").some((part) => part === "node_modules" || part === ".git"))
        this.schedule(uri.fsPath);
    };
    this.subscriptions.push(
      watcher,
      watcher.onDidChange(changed),
      watcher.onDidCreate(changed),
      watcher.onDidDelete(changed),
    );
    const sessionsWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(sessionsDirectory), "**/*.jsonl"),
    );
    const sessionChanged = () => {
      if (this.mode === "lastTurn" || this.lastTurnEditors.size) this.schedule();
    };
    this.subscriptions.push(
      sessionsWatcher,
      sessionsWatcher.onDidCreate(sessionChanged),
      sessionsWatcher.onDidChange(sessionChanged),
      sessionsWatcher.onDidDelete(sessionChanged),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.schedule()),
    );
    void vscode.commands.executeCommand("setContext", "vsvibe.loading", true);
    void vscode.commands.executeCommand("setContext", "vsvibe.ready", true);
  }

  initialize(git: GitAPI): void {
    if (this.disposed) return;
    this.git = git;
    this.subscriptions.push(
      git.onDidOpenRepository(() => this.syncRepositories()),
      git.onDidCloseRepository(() => this.syncRepositories()),
    );
    this.syncRepositories();
  }

  async initializationFailed(error: unknown): Promise<void> {
    if (this.disposed) return;
    this.view.message = errorMessage(error);
    await vscode.commands.executeCommand("setContext", "vsvibe.loading", false);
  }

  private syncRepositories(): void {
    if (!this.git) return;
    const roots = new Set(this.git.repositories.map((repository) => repository.rootUri.toString()));
    for (const [root, subscription] of this.repositories) {
      if (!roots.has(root)) {
        subscription.dispose();
        this.repositories.delete(root);
      }
    }
    for (const repository of this.git.repositories) {
      const key = repository.rootUri.toString();
      if (!this.repositories.has(key))
        this.repositories.set(
          key,
          repository.state.onDidChange(() => this.schedule()),
        );
    }
    this.schedule();
  }

  private schedule(path?: string): void {
    if (this.disposed) return;
    if (path) this.pendingPaths.add(path);
    else this.refreshRequested = true;
    const generation = ++this.scheduleGeneration;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refreshScheduled(generation);
    }, 250);
  }

  private async refreshScheduled(generation: number): Promise<void> {
    let needed = this.refreshRequested;
    if (!needed) {
      try {
        needed = await this.hasRelevantChanges([...this.pendingPaths]);
      } catch {
        // Refresh if Git cannot classify the paths rather than miss a change.
        needed = true;
      }
    }
    if (this.disposed || generation !== this.scheduleGeneration) return;
    this.pendingPaths.clear();
    this.refreshRequested = false;
    if (needed) await this.refresh();
  }

  private async hasRelevantChanges(paths: string[]): Promise<boolean> {
    const git = this.git;
    if (!git) return true;
    const roots = git.repositories
      .filter(({ rootUri }) => rootUri.scheme === "file")
      .map(({ rootUri }) => rootUri.fsPath)
      .sort((a, b) => b.length - a.length);
    const batches = new Map<string, string[]>();
    for (const path of paths) {
      const root = roots.find((root) => {
        const local = relative(root, path);
        return local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local);
      });
      if (!root) return true;
      const batch = batches.get(root) ?? [];
      batch.push(relative(root, path) || ".");
      batches.set(root, batch);
    }
    for (const [root, batch] of batches) {
      const ignored = await new Repository(root, git.git.path).ignoredPaths(batch);
      if (batch.some((path) => !ignored.has(path))) return true;
    }
    return false;
  }

  private scheduleExpand(): void {
    if (this.expandTimer) clearTimeout(this.expandTimer);
    this.expandTimer = setTimeout(() => {
      if (this.disposed) return;
      const active = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      if (
        active instanceof vscode.TabInputTextDiff &&
        [...this.lastTurnEditors.values()].some(
          ({ right }) => right.toString() === active.modified.toString(),
        )
      )
        void vscode.commands.executeCommand("diffEditor.showAllUnchangedRegions");
    }, 100);
  }

  private get modeLabel(): string {
    return scopeLabels[this.mode];
  }

  getChildren(element?: ReviewNode): ReviewNode[] {
    if (element) return "children" in element ? element.children : [];
    if (this.layout === "tree") return this.tree;
    const entries = [...this.entries.values()];
    return this.sortOrder === "status" ? entries.sort(compareStatus) : entries;
  }

  getParent(element: ReviewNode): ReviewNode | undefined {
    if (this.layout !== "tree") return undefined;
    const find = (nodes: ReviewNode[]): ReviewNode | undefined => {
      for (const node of nodes) {
        if (!("children" in node)) continue;
        if (node.children.includes(element)) return node;
        const parent = find(node.children);
        if (parent) return parent;
      }
      return undefined;
    };
    return find(this.tree);
  }

  async setSort(order: SortOrder): Promise<void> {
    if (order === this.sortOrder) return;
    this.sortOrder = order;
    this.tree = buildTree([...this.entries.values()], order);
    this.changed.fire();
    await Promise.all([
      vscode.commands.executeCommand("setContext", "vsvibe.sort", order),
      this.context.workspaceState.update("changes.sort", order),
    ]);
  }

  async setLayout(layout: Layout): Promise<void> {
    if (layout === this.layout) return;
    this.layout = layout;
    this.changed.fire();
    await Promise.all([
      vscode.commands.executeCommand("setContext", "vsvibe.layout", layout),
      this.context.workspaceState.update("changes.layout", layout),
    ]);
  }

  getTreeItem(entry: ReviewNode): vscode.TreeItem {
    if ("children" in entry) {
      const item = new vscode.TreeItem(entry.name, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `folder:${JSON.stringify([entry.root, entry.path])}`;
      item.resourceUri = vscode.Uri.joinPath(vscode.Uri.file(entry.root), entry.path).with({
        scheme: "vsvibe-folder",
      });
      item.iconPath = vscode.ThemeIcon.Folder;
      item.tooltip = entry.path || entry.root;
      return item;
    }
    const uri = vscode.Uri.joinPath(vscode.Uri.file(entry.repository.root), entry.path);
    const item = new vscode.TreeItem(basename(entry.path), vscode.TreeItemCollapsibleState.None);
    item.id = uri.toString();
    // Scope decorations to Review so the built-in Git badges cannot overlap.
    item.resourceUri = uri.with({ scheme: "vsvibe-review" });
    item.iconPath = vscode.ThemeIcon.File;
    item.contextValue = "reviewFile";
    const directory = dirname(entry.path);
    const repository =
      (this.git?.repositories.length ?? 0) > 1 ? basename(entry.repository.root) : "";
    item.description =
      this.layout === "list"
        ? [repository, directory === "." ? "" : directory].filter(Boolean).join(" · ")
        : "";
    const status = statusDetails[entry.status]?.label ?? entry.status;
    item.tooltip =
      entry.originalPath === entry.path ? entry.path : `${entry.originalPath} → ${entry.path}`;
    item.accessibilityInformation = { label: `${item.tooltip} (${status})` };
    item.command = { command: "vsvibe.openDiff", title: "Open Diff", arguments: [item.id] };
    return item;
  }

  async setMode(mode: Mode): Promise<void> {
    if (mode === this.mode) return;
    this.mode = mode;
    await Promise.all([
      this.refresh(),
      vscode.commands.executeCommand("setContext", "vsvibe.scope", mode),
      this.context.workspaceState.update("changes.mode", mode),
    ]);
  }

  async refresh(): Promise<void> {
    this.scheduleGeneration++;
    this.pendingPaths.clear();
    this.refreshRequested = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.disposed || (!this.git && this.mode !== "lastTurn" && !this.lastTurnEditors.size))
      return;
    const generation = ++this.generation;
    const mode = this.mode;
    if (mode !== "lastTurn" && this.lastTurnEditors.size)
      await this.loadLastTurn(generation, false);
    if (this.disposed || generation !== this.generation) return;
    const selected = this.view.selection[0];
    if (selected && !("children" in selected)) {
      this.selectedId = vscode.Uri.joinPath(
        vscode.Uri.file(selected.repository.root),
        selected.path,
      ).toString();
    }
    this.view.title = this.modeLabel;
    await vscode.commands.executeCommand("setContext", "vsvibe.loading", true);
    try {
      await vscode.window.withProgress({ location: { viewId: "vsvibe.changes" } }, () =>
        this.loadChanges(generation, mode),
      );
    } finally {
      if (!this.disposed && generation === this.generation) {
        await vscode.commands.executeCommand("setContext", "vsvibe.loading", false);
      }
    }
  }

  private async loadLastTurn(generation: number, publish = true): Promise<void> {
    const folders =
      vscode.workspace.workspaceFolders?.filter(({ uri }) => uri.scheme === "file") ?? [];
    const entries = new Map<string, Entry>();
    let reliable = true;
    for (const folder of folders) {
      try {
        const result = await this.lastTurn.read(folder.uri.fsPath);
        const repository = new Repository(folder.uri.fsPath);
        for (const file of result.files) {
          const id = vscode.Uri.joinPath(folder.uri, file.path).toString();
          entries.set(id, {
            ...file,
            repository,
            mode: "lastTurn",
            base: undefined,
            recorded: file,
          });
        }
      } catch {
        reliable = false;
        // Unavailable sessions use the shared empty state.
      }
    }
    if (this.disposed || generation !== this.generation) return;
    this.refreshLastTurnEditors(entries);
    if (publish) await this.publishChanges(generation, entries, [], reliable);
    else void this.reconcileDiffs("lastTurn", entries, reliable);
  }

  private refreshLastTurnEditors(entries: Map<string, Entry>): void {
    for (const [id, editor] of this.lastTurnEditors) {
      const entry =
        entries.get(id) ??
        [...entries.values()].find(
          (entry) => entry.repository.root === editor.root && entry.originalPath === editor.path,
        );
      const previous = editor.after;
      const before = entry?.recorded?.before ?? previous;
      const after = entry?.recorded?.after ?? previous;
      if (entry) editor.path = entry.path;
      this.updateSnapshot(editor.left, before);
      editor.after = after;
      if (editor.right.scheme === "vsvibe-diff") this.updateSnapshot(editor.right, after);
    }
  }

  private updateSnapshot(uri: vscode.Uri, content: string): void {
    if (this.snapshots.get(uri.toString()) === content) return;
    this.snapshots.set(uri.toString(), content);
    this.persistSnapshot(uri, content);
    this.snapshotChanged.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  private snapshotPath(uri: vscode.Uri): string {
    const name = createHash("sha256").update(uri.toString()).digest("hex");
    return join(this.context.globalStorageUri.fsPath, "review-snapshots", name);
  }

  private persistSnapshot(uri: vscode.Uri, content: string): void {
    const path = this.snapshotPath(uri);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }

  private async snapshotStat(uri: vscode.Uri): Promise<vscode.FileStat> {
    if (!uri.query) return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
    try {
      const info = await stat(this.snapshotPath(uri));
      return {
        type: vscode.FileType.File,
        ctime: info.ctimeMs,
        mtime: info.mtimeMs,
        size: info.size,
      };
    } catch {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
  }

  private async readSnapshot(uri: vscode.Uri): Promise<Uint8Array> {
    try {
      return await readFile(this.snapshotPath(uri));
    } catch {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
  }

  private async loadChanges(generation: number, mode: Mode): Promise<void> {
    if (mode === "lastTurn") return this.loadLastTurn(generation);
    const git = this.git;
    if (!git) return;
    const repositories = git.repositories.filter(
      (repository) => repository.rootUri.scheme === "file",
    );
    const results = await Promise.all(
      repositories.map(async ({ rootUri }) => {
        const repository = new Repository(rootUri.fsPath, git.git.path);
        try {
          const configured = vscode.workspace
            .getConfiguration("vsvibe", rootUri)
            .get<string>("defaultBranch", "")
            .trim();
          return { repository, changes: await repository.changes(mode, configured), error: "" };
        } catch (error) {
          return { repository, changes: undefined, error: errorMessage(error) };
        }
      }),
    );
    if (this.disposed || generation !== this.generation || !this.view) return;
    const entries = new Map<string, Entry>();
    const messages = [];
    for (const { repository, changes, error } of results) {
      const label = basename(repository.root);
      if (error) messages.push(repositories.length > 1 ? `${label}: ${error}` : error);
      for (const file of changes?.files ?? []) {
        const id = vscode.Uri.joinPath(vscode.Uri.file(repository.root), file.path).toString();
        entries.set(id, { ...file, repository, base: changes?.base, mode });
      }
    }
    await this.publishChanges(generation, entries, messages);
  }

  private async publishChanges(
    generation: number,
    entries: Map<string, Entry>,
    messages: string[],
    reliable = messages.length === 0,
  ): Promise<void> {
    if (this.disposed || generation !== this.generation) return;
    this.entries = entries;
    this.tree = buildTree([...entries.values()], this.sortOrder);
    this.view.message = messages.join("\n");
    this.view.badge = entries.size
      ? {
          value: entries.size,
          tooltip: `${entries.size} ${entries.size === 1 ? "file" : "files"} (${this.modeLabel})`,
        }
      : undefined;
    await vscode.commands.executeCommand(
      "setContext",
      "vsvibe.empty",
      entries.size === 0 && messages.length === 0,
    );
    if (this.disposed || generation !== this.generation) return;
    this.decorationsChanged.fire(undefined);
    this.changed.fire();
    void this.reconcileDiffs(this.mode, entries, reliable);
    const selected = this.selectedId ? entries.get(this.selectedId) : undefined;
    if (selected) {
      if (this.view.visible)
        await this.view.reveal(selected, { select: true, focus: false, expand: false });
    } else {
      this.selectedId = undefined;
    }
  }

  private snapshot(path: string, content: string, identity: string, live = false): vscode.Uri {
    const query = createHash("sha256")
      .update(JSON.stringify(live ? [identity] : [identity, content]))
      .digest("hex");
    const uri = vscode.Uri.from({ scheme: "vsvibe-diff", path: `/${path}`, query });
    if (live) this.updateSnapshot(uri, content);
    else {
      this.snapshots.set(uri.toString(), content);
      this.persistSnapshot(uri, content);
    }
    return uri;
  }

  async openFile(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    try {
      let uri = vscode.Uri.joinPath(vscode.Uri.file(entry.repository.root), entry.path);
      try {
        await vscode.workspace.fs.stat(uri);
      } catch (error) {
        if (!(error instanceof vscode.FileSystemError) || error.code !== "FileNotFound")
          throw error;
        const content = entry.recorded
          ? entry.recorded.before
          : entry.status === "D" && entry.base
            ? await entry.repository.content(entry.base, entry.originalPath)
            : entry.mode === "staged"
              ? await entry.repository.indexContent(entry.path)
              : undefined;
        if (content === undefined) throw error;
        uri = this.snapshot(
          entry.path,
          content,
          JSON.stringify([id, entry.mode, entry.base, "file"]),
        );
      }
      await vscode.commands.executeCommand("vscode.open", uri, {
        preview: true,
        preserveFocus: true,
      });
    } catch (error) {
      await vscode.window.showErrorMessage(`Could not open file: ${errorMessage(error)}`);
    }
  }

  async findFile(): Promise<void> {
    if (this.disposed || !this.entries.size) return;
    const mode = this.mode;
    const multipleRoots =
      new Set([...this.entries.values()].map((entry) => entry.repository.root)).size > 1;
    const items = [...this.entries].map(([id, entry]) => ({
      id,
      label: basename(entry.path),
      description: multipleRoots ? `${entry.repository.root} · ${entry.path}` : entry.path,
    }));
    const selected = await vscode.window.showQuickPick(items, {
      title: `Find Review File (${this.modeLabel})`,
      placeHolder: "Search files in this review scope",
      matchOnDescription: true,
    });
    if (selected && !this.disposed && this.mode === mode) await this.openDiff(selected.id);
  }

  async openAllDiffs(): Promise<void> {
    const entries = [...this.entries];
    if (!entries.length || this.disposed) return;
    const tabs = vscode.window.tabGroups.all.flatMap((group) =>
      group.tabs.filter((tab) => !tab.isDirty),
    );
    if (tabs.length && !(await vscode.window.tabGroups.close(tabs, true))) return;
    if (this.disposed) return;
    await Promise.all(entries.map(([id, entry]) => this.openDiff(id, false, entry)));
  }

  async openDiff(id: string, preview = true, entry = this.entries.get(id)): Promise<void> {
    if (!entry) return;
    const key = `${entry.mode}:${id}:${preview}`;
    const pending = this.openingDiffs.get(key);
    if (pending) return pending;
    const opening = this.showDiff(id, entry, preview)
      .catch((error: unknown) => {
        void vscode.window.showErrorMessage(`Could not open diff: ${errorMessage(error)}`);
      })
      .finally(() => this.openingDiffs.delete(key));
    this.openingDiffs.set(key, opening);
    return opening;
  }

  private async diffPair(
    id: string,
    entry: Entry,
  ): Promise<{ left: vscode.Uri; right: vscode.Uri }> {
    const { repository, base, path, originalPath, status, mode } = entry;
    const content =
      entry.recorded?.before ?? (base ? await repository.content(base, originalPath) : "");
    const identity = JSON.stringify(
      mode === "lastTurn" ? [id, mode] : [id, mode, base, originalPath],
    );
    const left = this.snapshot(originalPath, content, `${identity}:left`, mode === "lastTurn");
    const workingUri = vscode.Uri.joinPath(vscode.Uri.file(repository.root), path);
    const deleted =
      status === "D" ||
      (status === "U" &&
        !(await stat(workingUri.fsPath).then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return false;
            throw error;
          },
        )));
    const right =
      mode === "staged"
        ? this.snapshot(
            path,
            status === "D" ? "" : await repository.indexContent(path),
            `${identity}:right`,
          )
        : deleted
          ? this.snapshot(path, "", `${identity}:right`, mode === "lastTurn")
          : workingUri;
    return { left, right };
  }

  private async showDiff(id: string, entry: Entry, preview: boolean): Promise<void> {
    const { repository, path, status, mode } = entry;
    if (status === "A") {
      const uri =
        mode === "staged"
          ? this.snapshot(
              path,
              await repository.indexContent(path),
              JSON.stringify([id, mode, entry.base, "added"]),
            )
          : vscode.Uri.joinPath(vscode.Uri.file(repository.root), path);
      const active = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      if (
        preview &&
        active instanceof vscode.TabInputText &&
        active.uri.toString() === uri.toString()
      )
        return;
      await vscode.commands.executeCommand("vscode.open", uri, { preview, preserveFocus: true });
      return;
    }
    const { left, right } = await this.diffPair(id, entry);
    if (entry.recorded) {
      this.lastTurnEditors.set(id, {
        left,
        right,
        root: repository.root,
        path,
        after: entry.recorded.after,
      });
      this.scheduleExpand();
    }
    const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
    const active = activeTab?.input;
    const alreadyOpen =
      preview &&
      active instanceof vscode.TabInputTextDiff &&
      active.original.toString() === left.toString() &&
      active.modified.toString() === right.toString();
    try {
      if (!alreadyOpen)
        await vscode.commands.executeCommand(
          "vscode.diff",
          left,
          right,
          diffTitle(basename(path), mode, false),
          { preview, preserveFocus: true },
        );
      const key = `${mode}:${id}`;
      const tracked = this.reviewDiffs.get(key);
      const matchingTabs = this.openTabsForPair(left, right);
      const struck = Boolean(
        matchingTabs.some(({ tab }) => tab.label === diffTitle(basename(path), mode, true)) ||
        (tracked?.struck &&
          tracked.left.toString() === left.toString() &&
          tracked.right.toString() === right.toString()),
      );
      this.reviewDiffs.set(key, {
        id,
        mode,
        root: repository.root,
        path,
        originalPath: entry.originalPath,
        left,
        right,
        struck,
      });
      if (struck) await this.reconcileDiffs(mode, new Map([[id, entry]]), true);
      if (entry.recorded) this.scheduleExpand();
    } catch (error) {
      this.snapshots.delete(left.toString());
      if (right.scheme === "vsvibe-diff") this.snapshots.delete(right.toString());
      if (entry.recorded) this.lastTurnEditors.delete(id);
      throw error;
    }
  }

  private openTabsForPair(
    left: vscode.Uri,
    right: vscode.Uri,
  ): { tab: vscode.Tab; group: vscode.TabGroup }[] {
    const matches: { tab: vscode.Tab; group: vscode.TabGroup }[] = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (
          input instanceof vscode.TabInputTextDiff &&
          input.original.toString() === left.toString() &&
          input.modified.toString() === right.toString()
        )
          matches.push({ tab, group });
      }
    }
    return matches;
  }

  private reconcileQueue: Promise<void> | undefined;

  private reconcileDiffs(
    mode: Mode,
    entries: Map<string, Entry>,
    reliable: boolean,
  ): Promise<void> {
    // Serial runs keep one reconcile from pruning tabs another is retitling.
    this.reconcileQueue ??= Promise.resolve();
    const run = this.reconcileQueue.then(() => this.runReconcileDiffs(mode, entries, reliable));
    this.reconcileQueue = run.catch(() => undefined);
    return run;
  }

  private async runReconcileDiffs(
    mode: Mode,
    entries: Map<string, Entry>,
    reliable: boolean,
  ): Promise<void> {
    if (this.disposed) return;
    for (const [key, record] of this.reviewDiffs) {
      const open = this.openTabsForPair(record.left, record.right);
      if (!open.length) {
        this.reviewDiffs.delete(key);
        continue;
      }
      if (record.mode !== mode) continue;
      const found = findEntry(entries, record);
      // Added files open as plain editors, so their old diffs count as resolved.
      const active = found && found.entry.status !== "A" ? found : undefined;
      const struck = !active;
      if (
        (struck === record.struck &&
          (!active || (active.id === record.id && active.entry.path === record.path))) ||
        (struck && !reliable)
      )
        continue;
      try {
        const pair = active ? await this.diffPair(active.id, active.entry) : record;
        const title = diffTitle(
          basename(active ? active.entry.path : record.path),
          record.mode,
          struck,
        );
        const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
        const lastTurnEditor = this.lastTurnEditors.get(record.id);
        const closed = await vscode.window.tabGroups.close(
          open.map(({ tab }) => tab),
          true,
        );
        if (!closed) continue;
        for (const { tab, group } of open.sort(
          (a, b) => Number(a.tab === activeTab) - Number(b.tab === activeTab),
        )) {
          await vscode.commands.executeCommand("vscode.diff", pair.left, pair.right, title, {
            preview: tab.isPreview,
            viewColumn: group.viewColumn,
            preserveFocus: tab !== activeTab,
          });
        }
        if (active) {
          if (active.id !== record.id) this.lastTurnEditors.delete(record.id);
          record.id = active.id;
          record.root = active.entry.repository.root;
          record.path = active.entry.path;
          record.originalPath = active.entry.originalPath;
          const renamedKey = `${record.mode}:${record.id}`;
          if (key !== renamedKey) {
            this.reviewDiffs.delete(key);
            this.reviewDiffs.set(renamedKey, record);
          }
          if (active.entry.recorded) {
            this.lastTurnEditors.set(active.id, {
              left: pair.left,
              right: pair.right,
              root: active.entry.repository.root,
              path: active.entry.path,
              after: active.entry.recorded.after,
            });
          }
        } else if (lastTurnEditor) this.lastTurnEditors.set(record.id, lastTurnEditor);
        record.left = pair.left;
        record.right = pair.right;
        record.struck = struck;
      } catch {
        // Keep the current tab and retry on the next state change.
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    if (this.expandTimer) clearTimeout(this.expandTimer);
    this.repositories.forEach((subscription) => subscription.dispose());
    this.subscriptions.forEach((subscription) => subscription.dispose());
    this.snapshots.clear();
    this.reviewDiffs.clear();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function strikeout(text: string): string {
  return [...text].map((character) => `${character}\u0336`).join("");
}

function diffTitle(name: string, mode: Mode, struck: boolean): string {
  return `${struck ? strikeout(name) : name} (${scopeLabels[mode]})`;
}
