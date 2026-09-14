import type { Event, Uri } from "vscode";

// Only the public built-in Git API members used by this extension.
export interface GitRepository {
  rootUri: Uri;
  state: { onDidChange: Event<void> };
}
export interface GitAPI {
  git: { path: string };
  repositories: GitRepository[];
  onDidOpenRepository: Event<GitRepository>;
  onDidCloseRepository: Event<GitRepository>;
}
export interface GitExtension {
  getAPI(version: 1): GitAPI;
}
