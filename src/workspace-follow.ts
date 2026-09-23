import { realpath, stat } from "node:fs/promises";
import * as vscode from "vscode";
import { ActiveChat } from "./active-chat";
import { savedSidebarView } from "./sidebar-state";
import { chatWorkspace } from "./t3-workspace";

const handoffKey = "activeChat.workspaceHandoff";

interface Handoff {
  path: string;
  time: number;
  view?: string;
}

export class WorkspaceFollow implements vscode.Disposable {
  private readonly subscription: vscode.Disposable;
  private switching = false;
  private pendingId: string | undefined;
  private disposed = false;
  private generation = 0;

  constructor(
    chat: ActiveChat,
    private readonly context: vscode.ExtensionContext,
    private readonly resolveWorkspace = chatWorkspace,
  ) {
    this.subscription = chat.onDidChange((id) => this.follow(id));
    if (chat.id) this.follow(chat.id);
  }

  private follow(id: string | undefined): void {
    const generation = ++this.generation;
    if (!id) {
      this.pendingId = undefined;
      return;
    }
    if (this.switching) {
      this.pendingId = id;
      return;
    }
    void this.switchToChat(id, generation);
  }

  private async switchToChat(id: string, generation: number): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (folders?.length !== 1 || folders[0]?.uri.scheme !== "file") return;
    const target = this.resolveWorkspace(id);
    if (!target) return;
    let ownsSwitch = false;
    try {
      const [currentPath, targetPath, targetStat] = await Promise.all([
        realpath(folders[0].uri.fsPath),
        realpath(target),
        stat(target),
      ]);
      if (this.disposed || generation !== this.generation || !targetStat.isDirectory()) return;
      const handoff = this.context.globalState.get<Handoff>(handoffKey);
      if (handoff?.path === currentPath && Date.now() - handoff.time < 30_000) {
        await this.context.globalState.update(handoffKey, undefined);
        if (handoff.view) {
          try {
            await vscode.commands.executeCommand(handoff.view);
          } catch {
            // A view can disappear when its extension is disabled.
          }
        }
      }
      if (this.disposed || generation !== this.generation) return;
      if (currentPath === targetPath) return;
      if (this.switching) return;
      this.switching = true;
      ownsSwitch = true;
      const view = await savedSidebarView(this.context.storageUri, targetPath);
      if (this.disposed || generation !== this.generation) return;
      await this.context.globalState.update(handoffKey, {
        path: targetPath,
        time: Date.now(),
        view,
      });
      if (this.disposed || generation !== this.generation) {
        await this.context.globalState.update(handoffKey, undefined);
        return;
      }
      await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(targetPath), {
        forceReuseWindow: true,
      });
    } catch {
      if (ownsSwitch) await this.context.globalState.update(handoffKey, undefined);
    } finally {
      if (ownsSwitch) {
        this.switching = false;
        const pending = this.pendingId;
        this.pendingId = undefined;
        if (!this.disposed && pending) this.follow(pending);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.subscription.dispose();
  }
}
