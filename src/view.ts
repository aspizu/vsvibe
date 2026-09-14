import { createHash } from "node:crypto";
import { basename, dirname } from "node:path";
import { stat } from "node:fs/promises";
import * as vscode from "vscode";
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
  private readonly openingDiffs = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setTimeout> | undefined;
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
      this.view.onDidChangeVisibility(({ visible }) => {
        if (visible) void this.refresh();
      }),
      vscode.workspace.registerTextDocumentContentProvider("vsvibe-diff", {
        provideTextDocumentContent: (uri) => this.snapshots.get(uri.toString()) ?? "",
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        this.snapshots.delete(document.uri.toString());
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("vsvibe.defaultBranch")) this.schedule();
      }),
    );
    const watcher = vscode.workspace.createFileSystemWatcher("**/*");
    const changed = (uri: vscode.Uri) => {
      if (!uri.path.split("/").some((part) => part === "node_modules" || part === ".git"))
        this.schedule();
    };
    this.subscriptions.push(
      watcher,
      watcher.onDidChange(changed),
      watcher.onDidCreate(changed),
      watcher.onDidDelete(changed),
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

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.refresh();
    }, 250);
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
    item.tooltip = `${entry.originalPath === entry.path ? entry.path : `${entry.originalPath} → ${entry.path}`} (${status})`;
    item.accessibilityInformation = { label: item.tooltip };
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
    if (this.disposed || !this.git) return;
    const generation = ++this.generation;
    const mode = this.mode;
    const selected = this.view.selection[0];
    if (selected && !("children" in selected)) {
      this.selectedId = vscode.Uri.joinPath(
        vscode.Uri.file(selected.repository.root),
        selected.path,
      ).toString();
    }
    this.entries.clear();
    this.tree = [];
    this.view.title = this.modeLabel;
    this.view.message = "";
    this.decorationsChanged.fire(undefined);
    this.changed.fire();
    if (!this.view.visible) return;
    await Promise.all([
      vscode.commands.executeCommand("setContext", "vsvibe.empty", false),
      vscode.commands.executeCommand("setContext", "vsvibe.loading", true),
    ]);
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

  private async loadChanges(generation: number, mode: Mode): Promise<void> {
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
    this.entries = entries;
    this.tree = buildTree([...entries.values()], this.sortOrder);
    this.view.message = messages.join("\n");
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
      await this.view.reveal(selected, { select: true, focus: false, expand: false });
    } else {
      this.selectedId = undefined;
    }
  }

  private snapshot(path: string, content: string, identity: string): vscode.Uri {
    const query = createHash("sha256")
      .update(JSON.stringify([identity, content]))
      .digest("hex");
    const uri = vscode.Uri.from({ scheme: "vsvibe-diff", path: `/${path}`, query });
    this.snapshots.set(uri.toString(), content);
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
        const content =
          entry.status === "D" && entry.base
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

  async openDiff(id: string): Promise<void> {
    const key = `${this.mode}:${id}`;
    const pending = this.openingDiffs.get(key);
    if (pending) return pending;
    const opening = this.showDiff(id)
      .catch((error: unknown) => {
        void vscode.window.showErrorMessage(`Could not open diff: ${errorMessage(error)}`);
      })
      .finally(() => this.openingDiffs.delete(key));
    this.openingDiffs.set(key, opening);
    return opening;
  }

  private async showDiff(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    const { repository, base, path, originalPath, status, mode } = entry;
    const content = base && status !== "A" ? await repository.content(base, originalPath) : "";
    const identity = JSON.stringify([id, mode, base, originalPath]);
    const left = this.snapshot(originalPath, content, `${identity}:left`);
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
          ? this.snapshot(path, "", `${identity}:right`)
          : workingUri;
    const active = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (
      active instanceof vscode.TabInputTextDiff &&
      active.original.toString() === left.toString() &&
      active.modified.toString() === right.toString()
    )
      return;
    const title = `${basename(path)} (${scopeLabels[mode]})`;
    try {
      await vscode.commands.executeCommand("vscode.diff", left, right, title, {
        preview: true,
        preserveFocus: true,
      });
    } catch (error) {
      this.snapshots.delete(left.toString());
      if (right.scheme === "vsvibe-diff") this.snapshots.delete(right.toString());
      throw error;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.repositories.forEach((subscription) => subscription.dispose());
    this.subscriptions.forEach((subscription) => subscription.dispose());
    this.snapshots.clear();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
