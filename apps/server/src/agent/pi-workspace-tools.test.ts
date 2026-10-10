import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { ProjectFileStore } from "./persistence/file-store.js";
import { createWorkspace } from "./backends/workspace.js";
import type { AgentWorkspace } from "./backends/types.js";
import { createPiWorkspaceTools } from "./pi-workspace-tools.js";

describe("Pi coding tools in the project workspace", () => {
  it("marks sandbox output truncation in the bash result", async () => {
    const backend = { execute: async () => ({ output: "partial", exitCode: null, truncated: true }) } as unknown as AgentWorkspace;
    const [, bash] = createPiWorkspaceTools(backend);
    expect((await bash.execute("bash", { command: "large-output" })).content[0])
      .toMatchObject({ text: expect.stringContaining("Output truncated by sandbox limit") });
  });

  it("persists write and edit through the project file store", async () => {
    const root = await mkdtemp(join(tmpdir(), "loomic-pi-store-"));
    try {
      const skillsRoot = join(root, "skills");
      await mkdir(skillsRoot);
      const files = new Map<string, string>();
      const fileStore = {
        get: async (_namespace: string[], key: string) => files.get(key) ?? null,
        put: async (_namespace: string[], key: string, content: string) => { files.set(key, content); },
        create: async (_namespace: string[], key: string, content: string) => {
          if (files.has(key)) return false;
          files.set(key, content);
          return true;
        },
      } as ProjectFileStore;
      const tools = createPiWorkspaceTools(createWorkspace({ sandboxDir: root, skillsRoot, canvasId: "canvas-1", fileStore }));
      const [read, , edit, write] = tools;
      await write.execute("write", { path: "/workspace/note.txt", content: "before" });
      await edit.execute("edit", { path: "/workspace/note.txt", edits: [{ oldText: "before", newText: "after" }] });
      expect(files.get("/note.txt")).toBe("after");
      expect((await read.execute("read", { path: "/workspace/note.txt" })).content[0]).toMatchObject({ text: "after" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("exposes read, bash, edit, and write without escaping the sandbox or editing Skills", async () => {
    const root = await mkdtemp(join(tmpdir(), "loomic-pi-tools-"));
    try {
      const skillsRoot = join(root, "skills");
      await mkdir(skillsRoot);
      await writeFile(join(skillsRoot, "SKILL.md"), "Read only");
      const tools = createPiWorkspaceTools(createWorkspace({ sandboxDir: root, skillsRoot }));
      expect(tools.map((tool) => tool.name)).toEqual(["read", "bash", "edit", "write"]);
      const [read, bash, edit, write] = tools;
      await write.execute("write-1", { path: "draft.txt", content: "first\nsecond" });
      await expect(write.execute("write-again", { path: "draft.txt", content: "changed" })).rejects.toThrow("already exists");
      expect((await read.execute("read-1", { path: "/draft.txt" })).content[0]).toMatchObject({ text: "first\nsecond" });
      await edit.execute("edit-1", { path: "/draft.txt", edits: [{ oldText: "second", newText: "updated" }] });
      expect(await readFile(join(root, "draft.txt"), "utf8")).toBe("first\nupdated");
      expect((await bash.execute("bash-1", { command: "cat draft.txt" })).content[0]).toMatchObject({ text: expect.stringContaining("first\nupdated") });
      await expect(write.execute("write-2", { path: "/skills/SKILL.md", content: "changed" })).rejects.toThrow("read-only");
      await write.execute("write-3", { path: "/../normalized.txt", content: "inside" });
      expect(await readFile(join(root, "normalized.txt"), "utf8")).toBe("inside");
      await symlink(join(skillsRoot, "SKILL.md"), join(root, "linked.md"));
      await expect(write.execute("write-4", { path: "/linked.md", content: "changed" })).rejects.toThrow("already exists");
      await expect(edit.execute("edit-linked", { path: "/linked.md", edits: [{ oldText: "Read", newText: "Changed" }] })).rejects.toThrow("symlink");
      expect(await readFile(join(skillsRoot, "SKILL.md"), "utf8")).toBe("Read only");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
