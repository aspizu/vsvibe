import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

export const t3StatePath = join(homedir(), ".t3", "userdata", "state.sqlite");

export function chatWorkspace(id: string, databasePath = t3StatePath): string | undefined {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    const row = database
      .prepare(
        `SELECT COALESCE(NULLIF(t.worktree_path, ''), p.workspace_root) AS path
         FROM projection_threads t
         JOIN projection_projects p ON p.project_id = t.project_id
         WHERE t.thread_id = ? AND t.deleted_at IS NULL AND p.deleted_at IS NULL`,
      )
      .get(id) as { path?: unknown } | undefined;
    return typeof row?.path === "string" ? row.path : undefined;
  } catch {
    return undefined;
  } finally {
    database?.close();
  }
}
