import { execFile } from "node:child_process";
import { readFile, readdir, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import * as vscode from "vscode";

const run = promisify(execFile);
const activeViewKey = "workbench.sidebar.activeviewletid";

export async function savedSidebarView(
  storageUri: vscode.Uri | undefined,
  workspacePath: string,
): Promise<string | undefined> {
  if (storageUri?.scheme !== "file") return undefined;
  const storageRoot = dirname(dirname(storageUri.fsPath));
  let directories;
  try {
    directories = await readdir(storageRoot, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const directory of directories) {
    if (!directory.isDirectory()) continue;
    const storagePath = join(storageRoot, directory.name);
    try {
      const metadata = JSON.parse(await readFile(join(storagePath, "workspace.json"), "utf8"));
      if (typeof metadata.folder !== "string" || !metadata.folder.startsWith("file:")) continue;
      if ((await realpath(fileURLToPath(metadata.folder))) !== workspacePath) continue;
      const { stdout } = await run("sqlite3", [
        "-readonly",
        join(storagePath, "state.vscdb"),
        `SELECT value FROM ItemTable WHERE key = '${activeViewKey}' LIMIT 1;`,
      ]);
      const view = stdout.trim();
      return /^workbench\.view\.[\w.-]+$/.test(view) ? view : undefined;
    } catch {
      continue;
    }
  }
  return undefined;
}
