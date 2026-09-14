import { basename } from "node:path";

export type Layout = "list" | "tree";

interface FileEntry {
  path: string;
  repository: { root: string };
}

export interface Folder<T> {
  kind: "folder";
  name: string;
  path: string;
  root: string;
  children: Array<T | Folder<T>>;
}

export function buildTree<T extends FileEntry>(entries: T[]): Array<T | Folder<T>> {
  const roots = new Map<string, Folder<T>>();
  const folders = new Map<string, Folder<T>>();
  for (const entry of entries) {
    const root = entry.repository.root;
    let parent = roots.get(root);
    if (!parent) {
      parent = { kind: "folder", name: basename(root), path: "", root, children: [] };
      roots.set(root, parent);
    }
    const parts = entry.path.split("/");
    parts.pop();
    let path = "";
    for (const part of parts) {
      path = path ? `${path}/${part}` : part;
      const key = JSON.stringify([root, path]);
      let folder = folders.get(key);
      if (!folder) {
        folder = { kind: "folder", name: part, path, root, children: [] };
        folders.set(key, folder);
        parent.children.push(folder);
      }
      parent = folder;
    }
    parent.children.push(entry);
  }
  const isFolder = (node: T | Folder<T>): node is Folder<T> => "children" in node;
  const sort = (nodes: Array<T | Folder<T>>) => {
    nodes.sort(
      (a, b) =>
        Number(isFolder(b)) - Number(isFolder(a)) ||
        (isFolder(a) ? a.name : basename(a.path)).localeCompare(
          isFolder(b) ? b.name : basename(b.path),
        ),
    );
  };
  for (const folder of [...roots.values(), ...folders.values()]) sort(folder.children);
  const result = roots.size === 1 ? [...roots.values()][0]!.children : [...roots.values()];
  sort(result);
  return result;
}
