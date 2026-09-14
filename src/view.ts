import { randomUUID } from "node:crypto";
import { basename, dirname } from "node:path";
import { stat } from "node:fs/promises";
import * as vscode from "vscode";
import type { GitAPI } from "./git-api";
import { Repository, type Change, type Mode } from "./git";

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
  repository: Repository;
  base: string | undefined;
}

export class ChangesView implements vscode.TreeDataProvider<Entry>, vscode.Disposable {
  private readonly view: vscode.TreeView<Entry>;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly decorationsChanged = new vscode.EventEmitter<undefined>();
  private mode: Mode;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly repositories = new Map<string, vscode.Disposable>();
  private entries = new Map<string, Entry>();
  private readonly snapshots = new Map<string, string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private disposed = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly git: GitAPI,
  ) {
    this.mode =
      context.workspaceState.get<Mode>("changes.mode") === "uncommitted" ? "uncommitted" : "branch";
    this.view = vscode.window.createTreeView("vsvibe.changes", {
      treeDataProvider: this,
      showCollapseAll: false,
    });
    this.view.description = this.modeLabel;
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
      git.onDidOpenRepository(() => this.syncRepositories()),
      git.onDidCloseRepository(() => this.syncRepositories()),
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
    this.syncRepositories();
  }

  private syncRepositories(): void {
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
    return this.mode === "branch" ? "Branch" : "Uncommitted";
  }

  getChildren(element?: Entry): Entry[] {
    return element ? [] : [...this.entries.values()];
  }

  getTreeItem(entry: Entry): vscode.TreeItem {
    const uri = vscode.Uri.joinPath(vscode.Uri.file(entry.repository.root), entry.path);
    const item = new vscode.TreeItem(basename(entry.path), vscode.TreeItemCollapsibleState.None);
    item.id = uri.toString();
    // Scope decorations to Review so the built-in Git badges cannot overlap.
    item.resourceUri = uri.with({ scheme: "vsvibe-review" });
    item.iconPath = vscode.ThemeIcon.File;
    const directory = dirname(entry.path);
    const repository = this.git.repositories.length > 1 ? basename(entry.repository.root) : "";
    item.description = [repository, directory === "." ? "" : directory].filter(Boolean).join(" · ");
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
    if (this.disposed) return;
    const generation = ++this.generation;
    const mode = this.mode;
    this.entries.clear();
    this.view.description = this.modeLabel;
    this.view.message = "";
    this.decorationsChanged.fire(undefined);
    this.changed.fire();
    if (!this.view.visible) return;
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

  private async loadChanges(generation: number, mode: Mode): Promise<void> {
    const repositories = this.git.repositories.filter(
      (repository) => repository.rootUri.scheme === "file",
    );
    const results = await Promise.all(
      repositories.map(async ({ rootUri }) => {
        const repository = new Repository(rootUri.fsPath, this.git.git.path);
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
      if (error || changes?.message) messages.push(`${label}: ${error || changes?.message}`);
      for (const file of changes?.files ?? []) {
        const id = vscode.Uri.joinPath(vscode.Uri.file(repository.root), file.path).toString();
        entries.set(id, { ...file, repository, base: changes?.base });
      }
    }
    this.entries = entries;
    this.view.description = `${this.modeLabel} · ${entries.size}`;
    this.view.message = repositories.length
      ? messages.join("\n") || (entries.size ? "" : "No changes.")
      : "Open a folder with a Git repository to see changes.";
    this.decorationsChanged.fire(undefined);
    this.changed.fire();
  }

  private snapshot(path: string, content: string): vscode.Uri {
    const uri = vscode.Uri.from({ scheme: "vsvibe-diff", path: `/${path}`, query: randomUUID() });
    this.snapshots.set(uri.toString(), content);
    return uri;
  }

  async openDiff(id: string): Promise<void> {
    try {
      await this.showDiff(id);
    } catch (error) {
      await vscode.window.showErrorMessage(`Could not open diff: ${errorMessage(error)}`);
    }
  }

  private async showDiff(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    const { repository, base, path, originalPath, status } = entry;
    const content = base && status !== "A" ? await repository.content(base, originalPath) : "";
    const left = this.snapshot(originalPath, content);
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
    const right = deleted
      ? this.snapshot(path, "")
      : vscode.Uri.joinPath(vscode.Uri.file(repository.root), path);
    const title = `${originalPath === path ? path : `${originalPath} → ${path}`} (${this.mode === "branch" ? "Branch" : "Uncommitted"})`;
    try {
      await vscode.commands.executeCommand("vscode.diff", left, right, title, { preview: true });
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
