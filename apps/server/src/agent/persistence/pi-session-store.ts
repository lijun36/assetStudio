import pg from "pg";
import type { FileEntry } from "@earendil-works/pi-coding-agent";
import { createProjectFileStore } from "./file-store.js";

/** One transcript per server-owned thread. The table is created by a migration. */
export function createPiSessionStore(connectionString: string) {
  const pool = new pg.Pool({
    connectionString,
    max: 3,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  pool.on("error", (error) => console.error("[pi-session-pool] Idle client error:", error.message));
  return {
    fileStore: createProjectFileStore(pool),
    async loadEntries(threadId: string): Promise<FileEntry[] | null> {
      const { rows } = await pool.query<{ entries: FileEntry[] }>(
        "select entries from pi.threads where thread_id = $1",
        [threadId],
      );
      return rows[0]?.entries ?? null;
    },
    async saveEntries(threadId: string, entries: FileEntry[]): Promise<void> {
      await pool.query(
        `insert into pi.threads (thread_id, entries)
         values ($1, $2::jsonb)
         on conflict (thread_id) do update
         set entries = excluded.entries, updated_at = now()`,
        [threadId, JSON.stringify(entries)],
      );
    },
  };
}
