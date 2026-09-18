import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, relative, sep } from "node:path";
import { stat } from "node:fs/promises";
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

type ReviewNode = Entry | Folder<Entry>;

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
  private readonly snapshotChanged = new vscode.EventEmitter<vscode.Uri>();
  private readonly lastTurnEditors = new Map<
    string,
    { left: vscode.Uri; right: vscode.Uri; root: string; path: string; after: string }
  >();
  private readonly lastTurn = new LastTurnReader();
  private readonly openingDiffs = new Map<string, Promise<void>>();
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
      vscode.workspace.registerTextDocumentContentProvider("vsvibe-diff", {
        onDidChange: this.snapshotChanged.event,
        provideTextDocumentContent: (uri) => this.snapshots.get(uri.toString()) ?? "",
      }),
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
        // Unavailable sessions use the shared empty state.
      }
    }
    if (this.disposed || generation !== this.generation) return;
    this.refreshLastTurnEditors(entries);
    if (publish) await this.publishChanges(generation, entries, []);
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
    this.snapshotChanged.fire(uri);
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
    else this.snapshots.set(uri.toString(), content);
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

  private async showDiff(id: string, entry: Entry, preview: boolean): Promise<void> {
    const { repository, base, path, originalPath, status, mode } = entry;
    if (status === "A") {
      const uri =
        mode === "staged"
          ? this.snapshot(
              path,
              await repository.indexContent(path),
              JSON.stringify([id, mode, base, "added"]),
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
    const active = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (
      preview &&
      active instanceof vscode.TabInputTextDiff &&
      active.original.toString() === left.toString() &&
      active.modified.toString() === right.toString()
    )
      return;
    const title = `${basename(path)} (${scopeLabels[mode]})`;
    try {
      await vscode.commands.executeCommand("vscode.diff", left, right, title, {
        preview,
        preserveFocus: true,
      });
      if (entry.recorded) this.scheduleExpand();
    } catch (error) {
      this.snapshots.delete(left.toString());
      if (right.scheme === "vsvibe-diff") this.snapshots.delete(right.toString());
      if (entry.recorded) this.lastTurnEditors.delete(id);
      throw error;
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
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
