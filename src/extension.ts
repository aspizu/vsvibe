import * as vscode from "vscode";
import type { GitExtension } from "./git-api";
import { ChangesView } from "./view";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const extension = vscode.extensions.getExtension<GitExtension>("vscode.git");
  if (!extension) return;
  const git = (await extension.activate()).getAPI(1);
  const view = new ChangesView(context, git);
  for (const mode of ["uncommitted", "branch"] as const) {
    for (const suffix of ["", ".selected"]) {
      context.subscriptions.push(
        vscode.commands.registerCommand(`vsvibe.scope.${mode}${suffix}`, () => view.setMode(mode)),
      );
    }
  }
  context.subscriptions.push(
    view,
    vscode.commands.registerCommand("vsvibe.refresh", () => view.refresh()),
    vscode.commands.registerCommand("vsvibe.openDiff", (id: string) => view.openDiff(id)),
  );
}
