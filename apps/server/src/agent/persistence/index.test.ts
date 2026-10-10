import { describe, expect, it, vi } from "vitest";

import { createAgentPersistenceService } from "./index.js";
import { createPiSessionStore } from "./pi-session-store.js";

describe("Pi persistence", () => {
  it("returns no persistence without a database URL", async () => {
    const createStore = vi.fn();
    const service = createAgentPersistenceService({}, {
      createPiSessionStore: createStore as unknown as typeof createPiSessionStore,
    });

    expect(await service.getPersistence()).toBeNull();
    expect(createStore).not.toHaveBeenCalled();
  });

  it("loads Pi session entries and starts a new thread with an empty session", async () => {
    const entries = [{ type: "session", id: "session-1", timestamp: "2026-10-09T00:00:00Z", cwd: "/tmp" }];
    const loadEntries = vi.fn().mockResolvedValueOnce(entries).mockResolvedValueOnce(null);
    const saveEntries = vi.fn();
    const createStore = vi.fn(() => ({ fileStore: {}, loadEntries, saveEntries })) as unknown as typeof createPiSessionStore;
    const service = createAgentPersistenceService({ supabaseDbUrl: "postgres://test" }, {
      createPiSessionStore: createStore,
    });

    const persistence = await service.getPersistence();
    expect(await persistence?.loadEntries("thread-1")).toEqual(entries);
    expect(await persistence?.loadEntries("thread-2")).toEqual([]);
    await persistence?.saveEntries("thread-1", entries as never);
    expect(saveEntries).toHaveBeenCalledWith("thread-1", entries);
    expect(await service.getPersistence()).toBe(persistence);
    expect(createStore).toHaveBeenCalledOnce();
  });
});
