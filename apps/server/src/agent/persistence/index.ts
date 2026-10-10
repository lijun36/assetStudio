import type { FileEntry } from "@earendil-works/pi-coding-agent";

import type { ServerEnv } from "../../config/env.js";
import { createPiSessionStore } from "./pi-session-store.js";

export type AgentPersistence = {
  fileStore: ReturnType<typeof createPiSessionStore>["fileStore"];
  loadEntries(threadId: string): Promise<FileEntry[]>;
  saveEntries(threadId: string, entries: FileEntry[]): Promise<void>;
};

export type AgentPersistenceService = {
  getPersistence(): Promise<AgentPersistence | null>;
};

export function createAgentPersistenceService(
  env: Pick<ServerEnv, "supabaseDbUrl">,
  overrides?: {
    createPiSessionStore?: typeof createPiSessionStore;
  },
): AgentPersistenceService {
  let persistence: AgentPersistence | null = null;

  return {
    async getPersistence() {
      if (!env.supabaseDbUrl) return null;
      if (!persistence) {
        const store = (overrides?.createPiSessionStore ?? createPiSessionStore)(env.supabaseDbUrl);
        persistence = {
          fileStore: store.fileStore,
          async loadEntries(threadId) {
            return await store.loadEntries(threadId) ?? [];
          },
          saveEntries: store.saveEntries,
        };
      }
      return persistence;
    },
  };
}
