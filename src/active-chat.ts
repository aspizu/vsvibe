import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";

const run = promisify(execFile);
const pollInterval = 500;
const threadID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ActiveChat implements vscode.Disposable {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private executable: string | undefined;
  private activeId: string | undefined;
  private warnedAboutAccess = false;
  private readonly changed = new vscode.EventEmitter<string | undefined>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    if (process.platform === "darwin") void this.start();
  }

  get id(): string | undefined {
    return this.activeId;
  }

  private async start(): Promise<void> {
    try {
      this.executable = await this.buildHelper();
      if (!this.disposed) void this.poll();
    } catch {
      // The helper cannot be built, such as when Swift is unavailable.
    }
  }

  private async buildHelper(): Promise<string> {
    const source = join(this.context.extensionPath, "native", "t3-active-thread.swift");
    const hash = createHash("sha256")
      .update(await readFile(source))
      .digest("hex")
      .slice(0, 16);
    const directory = this.context.globalStorageUri.fsPath;
    const executable = join(directory, `t3-active-thread-${hash}`);
    try {
      await stat(executable);
      return executable;
    } catch {
      await mkdir(directory, { recursive: true });
    }
    const temporary = `${executable}-${process.pid}`;
    try {
      await run("swiftc", [source, "-o", temporary], { timeout: 60_000, maxBuffer: 1024 * 1024 });
      await rename(temporary, executable);
      return executable;
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async poll(): Promise<void> {
    try {
      const { stdout } = await run(this.executable!, [], { timeout: 5_000 });
      const value = stdout.trim();
      const next = threadID.test(value) ? value : undefined;
      if (next !== this.activeId) {
        this.activeId = next;
        this.changed.fire(next);
      }
    } catch (error) {
      if (
        !this.warnedAboutAccess &&
        String((error as { stderr?: unknown }).stderr).includes("Accessibility access is required")
      ) {
        this.warnedAboutAccess = true;
        void vscode.window.showWarningMessage(
          "VSVibe needs Accessibility access for Visual Studio Code to follow T3 chats. Enable it in System Settings > Privacy & Security > Accessibility.",
        );
      }
      if (this.activeId !== undefined) {
        this.activeId = undefined;
        this.changed.fire(undefined);
      }
    } finally {
      if (!this.disposed) this.timer = setTimeout(() => void this.poll(), pollInterval);
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.changed.dispose();
  }
}
