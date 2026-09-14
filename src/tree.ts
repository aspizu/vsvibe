import { basename } from "node:path";

export type Layout = "list" | "tree";
export type SortOrder = "name" | "status";

interface FileEntry {
  path: string;
  status?: string;
  repository: { root: string };
}

export interface Folder<T> {
  kind: "folder";
  name: string;
  path: string;
  root: string;
  children: Array<T | Folder<T>>;
}

export function compareStatus(a: FileEntry, b: FileEntry): number {
  return (a.status ?? "").localeCompare(b.status ?? "") || a.path.localeCompare(b.path);
}

export function buildTree<T extends FileEntry>(
  entries: T[],
  order: SortOrder = "name",
): Array<T | Folder<T>> {
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
        (order === "status" && !isFolder(a) && !isFolder(b) ? compareStatus(a, b) : 0) ||
        (isFolder(a) ? a.name : basename(a.path)).localeCompare(
          isFolder(b) ? b.name : basename(b.path),
        ),
    );
  };
  const compact = (nodes: Array<T | Folder<T>>) => {
    for (const node of nodes) {
      if (!isFolder(node)) continue;
      // Keep repository roots separate when displaying multiple repositories.
      while (node.path && node.children.length === 1) {
        const child = node.children[0]!;
        if (!isFolder(child)) break;
        node.name = `${node.name}/${child.name}`;
        node.path = child.path;
        node.children = child.children;
      }
      compact(node.children);
    }
    sort(nodes);
  };
  const result = roots.size === 1 ? [...roots.values()][0]!.children : [...roots.values()];
  compact(result);
  return result;
}
