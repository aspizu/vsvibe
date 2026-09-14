# VSVibe

**A focused home for code review in VS Code.**

Bring a Codex-style review workflow into your editor. See what changed in your branch, your working tree, or the latest completed Codex turn, then jump straight into the diff.

![VSVibe diff review with scope selection](./docs/screenshots/screenshot.png)

## Review the changes that matter

- **Choose your scope.** Switch between Branch, Uncommitted, Staged, Unstaged, and Last Turn from one dropdown.
- **Review the latest Codex turn.** Compare against the recorded baseline while keeping the working file live and editable.
- **Open the whole review.** Click the eye icon to open every diff in its own kept-open tab. Clean editor tabs are closed first; editors with unsaved changes stay open.
- **Browse your way.** Use a compact list or folder tree, sort by name or status, and see the file count on the activity bar.
- **Stay in context.** Changes update in the background while the current list stays visible. Click a file to preview its diff or open it directly for editing.

## Install

Requires VS Code 1.110 or later and Git.

1. [Download VSVibe](https://github.com/aspizu/vsvibe/releases/download/latest/vsvibe.vsix).
2. Open the Command Palette in VS Code and run **Extensions: Install from VSIX...**.
3. Select the downloaded `vsvibe.vsix` file.

The download always contains the latest successful build. To update, download it again and repeat the installation steps.

Open a Git project in VS Code, select **Review** in the activity bar, and choose a scope. **Last Turn** uses local Codex session history.
