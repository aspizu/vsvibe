import * as vscode from "vscode";
import type { GitExtension } from "./git-api";
import { ChangesView } from "./view";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const view = new ChangesView(context);
  context.subscriptions.push(view);
  for (const mode of ["lastTurn", "uncommitted", "unstaged", "staged", "branch"] as const) {
    for (const suffix of ["", ".selected"]) {
      context.subscriptions.push(
        vscode.commands.registerCommand(`vsvibe.scope.${mode}${suffix}`, () => view.setMode(mode)),
      );
    }
  }
  for (const layout of ["tree", "list"] as const) {
    for (const suffix of ["", ".selected"]) {
      context.subscriptions.push(
        vscode.commands.registerCommand(`vsvibe.layout.${layout}${suffix}`, () =>
          view.setLayout(layout),
        ),
      );
    }
  }
  for (const order of ["name", "status"] as const) {
    for (const suffix of ["", ".selected"]) {
      context.subscriptions.push(
        vscode.commands.registerCommand(`vsvibe.sort.${order}${suffix}`, () => view.setSort(order)),
      );
    }
  }
  for (const [command, target] of [
    ["revealInFinder", "revealFileInOS"],
    ["revealInFileExplorer", "revealFileInOS"],
    ["revealInFileManager", "revealFileInOS"],
    ["revealInExplorer", "revealInExplorer"],
  ] as const) {
    context.subscriptions.push(
      vscode.commands.registerCommand(
        `vsvibe.${command}`,
        (entry: { path: string; repository: { root: string } }) =>
          vscode.commands.executeCommand(
            target,
            vscode.Uri.joinPath(vscode.Uri.file(entry.repository.root), entry.path),
          ),
      ),
    );
  }
  context.subscriptions.push(
    vscode.commands.registerCommand("vsvibe.refresh", () => view.refresh()),
    vscode.commands.registerCommand("vsvibe.openDiff", (id: string) => view.openDiff(id)),
    vscode.commands.registerCommand(
      "vsvibe.copyPath",
      (entry: { path: string; repository: { root: string } }) =>
        vscode.env.clipboard.writeText(
          vscode.Uri.joinPath(vscode.Uri.file(entry.repository.root), entry.path).fsPath,
        ),
    ),
    vscode.commands.registerCommand("vsvibe.copyRelativePath", (entry: { path: string }) =>
      vscode.env.clipboard.writeText(entry.path),
    ),
    vscode.commands.registerCommand(
      "vsvibe.openFile",
      (entry: { path: string; repository: { root: string } }) =>
        view.openFile(
          vscode.Uri.joinPath(vscode.Uri.file(entry.repository.root), entry.path).toString(),
        ),
    ),
  );
  try {
    const extension = vscode.extensions.getExtension<GitExtension>("vscode.git");
    if (!extension) throw new Error("Enable VS Code's built-in Git extension to use Review.");
    view.initialize((await extension.activate()).getAPI(1));
  } catch (error) {
    await view.initializationFailed(error);
  }
}
