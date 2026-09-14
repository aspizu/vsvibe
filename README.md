# vsvibe

Browse changed files in the **Review** activity-bar sidebar. Select a file in the native TreeView to open its VS Code diff editor. Use **Review Scope** dropdown in the view toolbar to choose Branch or Uncommitted. A checkmark marks the active option; the current mode appears beside the view title.

- **Branch** (initial selection): net changes from the merge base with the default branch to the current working tree, including committed, staged, unstaged, and untracked files. On the default branch, switch to Uncommitted to see local changes.
- **Uncommitted**: net changes from HEAD to the working tree, including staged, unstaged, and untracked files. Before the first commit, existing files appear as additions.

The flat list shows native file icons, filenames, parent paths, and Git status letters. Renames compare the original path with the new path; added and deleted files use an empty side of the diff. Conflicts are marked U. Ignored files are excluded. Unsaved editor changes are not included in the Git file list until saved.

The selected mode persists per workspace. Changes refresh on Git state and file events, when the panel becomes visible, or with its Refresh button. Multiple repositories appear in the same list with repository labels.

Default-branch detection uses locally available remote HEAD refs (origin first), then local main or master. Set `vsvibe.defaultBranch` to a ref such as `upstream/trunk` if needed. Comparisons do not fetch from the network. Detached HEADs and repositories without a known default branch show an explanatory message in Branch mode.

## Development

Requires Node.js 24+, pnpm 12.3.4, and optionally [just](https://github.com/casey/just).

```sh
pnpm install
pnpm check
pnpm build
```

Open this directory in VS Code, install the recommended workspace extensions, and press F5 to launch an Extension Development Host. Click the Review activity-bar icon to open the sidebar. `pnpm watch` continuously rebuilds the source.

## Commands

Run `just` to list recipes. Each recipe delegates to the matching pnpm script, including `build`, `watch`, `lint`, `format`, `typecheck`, `test`, `check`, and `package`. `just fix` applies lint fixes and formatting; `just clean` removes compiled output.

TypeScript 7 compiles source to CommonJS in `dist/` with source maps. Oxlint checks code. Oxfmt formats its supported languages, including JSON, YAML, and Markdown. Prettier handles remaining recognized files using `.prettier-fallback-ignore` to avoid overlapping with Oxfmt. Install a Prettier plugin and configure it when adding a language that needs one; update formatter routing and ignore patterns alongside it. Neither formatter formats the justfile.

Lefthook installs during `pnpm install`. Pre-commit runs lint, formatting checks, and type checking; pre-push compiles. Run `pnpm hooks` to reinstall hooks. Hooks check files without modifying or staging them.

## Packaging and CI

`pnpm package` builds a local VSIX. `pnpm test` exercises real temporary Git repositories, including branch comparisons, renames, deletions, conflicts, untracked files, and default-branch detection. GitHub Actions runs quality checks and packages an artifact on pushes and pull requests. No publishing is configured.

Before publishing, set a Marketplace publisher, repository, description, and license in the manifest. Packaging excludes development files and source maps. There are no runtime dependencies; if those are added, bundle them or revise the packaging configuration before distributing the extension.
