import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { SessionManager, type FileEntry } from "@earendil-works/pi-coding-agent";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerEnv } from "../config/env.js";
import { describe, expect, it, vi } from "vitest";

import type { AgentBackendResult } from "./backends/index.js";
import { createWorkspace } from "./backends/workspace.js";
import type { AgentPersistence } from "./persistence/index.js";
import { createLoomicPiAgent } from "./pi-agent.js";

describe("Pi agent runtime", () => {
  it("registers Pi's four coding tools alongside the existing project tools", async () => {
    const faux = fauxProvider();
    faux.setResponses([(context) => {
      const names = getCurrentTools(context.messages).map((tool) => tool.name);
      expect(names).toEqual(expect.arrayContaining([
        "read", "bash", "edit", "write", "ls", "glob", "grep", "read_file",
        "generate_image", "generate_video", "task", "write_todos",
      ]));
      return fauxAssistantMessage("Ready");
    }]);
    const models = createModels();
    models.setProvider(faux.provider);
    const agent = createLoomicPiAgent({
      env: { openAIApiKey: "test", agentModel: "gpt-4.1" } as ServerEnv,
      model: faux.getModel(), streamFn: models.streamSimple.bind(models),
      backendResult: { workspace: {}, sandboxDir: "/tmp/test-pi-agent" } as unknown as AgentBackendResult,
    });
    const events = [];
    for await (const event of agent.stream(
      { role: "user", content: "List the available tools", timestamp: Date.now() },
      {}, new AbortController().signal,
    )) events.push(event);
    expect(events.some((event) => event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "stop")).toBe(true);
  });

  it("advertises a local Skill by metadata, then reads its instructions and relative references", async () => {
    const root = await mkdtemp(join(tmpdir(), "loomic-pi-skill-"));
    try {
      const skillsRoot = join(root, "skills");
      await mkdir(join(skillsRoot, "new-skill"), { recursive: true });
      await mkdir(join(skillsRoot, "new-skill", "references"));
      await writeFile(join(skillsRoot, "new-skill", "SKILL.md"), "---\nname: new-skill\ndescription: Use for a blue bird.\n---\n\nPaint a blue bird. Read references/guide.md for the palette.");
      await writeFile(join(skillsRoot, "new-skill", "references", "guide.md"), "Use cobalt blue. See ../details.md.");
      await writeFile(join(skillsRoot, "new-skill", "details.md"), "Keep the background white.");
      const faux = fauxProvider();
      faux.setResponses([
        (context) => {
          const transcript = JSON.stringify(context.messages);
          expect(transcript).toContain("/skills/new-skill/SKILL.md");
          expect(transcript).toContain("Use for a blue bird.");
          expect(transcript).not.toContain("Paint a blue bird.");
          return fauxAssistantMessage([fauxToolCall("read_file", { file_path: "/skills/new-skill/SKILL.md" })], { stopReason: "toolUse" });
        },
        (context) => {
          expect(JSON.stringify(context.messages)).toContain("Paint a blue bird. Read references/guide.md");
          return fauxAssistantMessage([fauxToolCall("read_file", { file_path: "references/guide.md", base_path: "/skills/new-skill/SKILL.md" })], { stopReason: "toolUse" });
        },
        () => fauxAssistantMessage([fauxToolCall("read_file", { file_path: "../details.md", base_path: "/skills/new-skill/references/guide.md" })], { stopReason: "toolUse" }),
        fauxAssistantMessage("I followed the skill."),
      ]);
      const models = createModels();
      models.setProvider(faux.provider);
      const workspace = createWorkspace({ sandboxDir: root, skillsRoot });
      const agent = createLoomicPiAgent({
        env: { openAIApiKey: "test", agentModel: "gpt-4.1" } as ServerEnv,
        model: faux.getModel(), streamFn: models.streamSimple.bind(models),
        backendResult: { workspace, sandboxDir: root, skillsRoot },
        discoverLocalSkills: true,
      });
      const events = [];
      for await (const event of agent.stream(
        { role: "user", content: "Paint a blue bird", timestamp: Date.now() },
        {}, new AbortController().signal,
      )) events.push(event);
      expect(events.find((event) => event.type === "tool_execution_end" && event.toolName === "read_file"))
        .toMatchObject({ result: { content: [{ type: "text", text: expect.stringContaining("Paint a blue bird.") }] } });
      expect(events.filter((event) => event.type === "tool_execution_end" && event.toolName === "read_file")[1])
        .toMatchObject({ result: { content: [{ type: "text", text: expect.stringContaining("Use cobalt blue.") }] } });
      expect(events.filter((event) => event.type === "tool_execution_end" && event.toolName === "read_file")[2])
        .toMatchObject({ result: { content: [{ type: "text", text: expect.stringContaining("Keep the background white.") }] } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("advertises an enabled workspace Skill without its body and resolves references inside it", async () => {
    const faux = fauxProvider();
    faux.setResponses([
      (context) => {
        const transcript = JSON.stringify(context.messages);
        expect(transcript).toContain("active: Use for a blue bird. (/workspace-skills/active/SKILL.md)");
        expect(transcript).not.toContain("Read references/guide.md");
        return fauxAssistantMessage([fauxToolCall("read_file", { file_path: "/workspace-skills/active/SKILL.md" })], { stopReason: "toolUse" });
      },
      () => fauxAssistantMessage([fauxToolCall("read_file", { file_path: "references/guide.md", base_path: "/workspace-skills/active/SKILL.md" })], { stopReason: "toolUse" }),
      () => fauxAssistantMessage([fauxToolCall("read_file", { file_path: "../other/SKILL.md", base_path: "/workspace-skills/active/SKILL.md" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("Done"),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const read = vi.fn(async (path: string) => {
      if (path === "/workspace-skills/active/SKILL.md") return "1\tRead references/guide.md";
      if (path === "/workspace-skills/active/references/guide.md") return "1\tUse cobalt blue.";
      throw new Error(`Unexpected path: ${path}`);
    });
    const agent = createLoomicPiAgent({
      env: { openAIApiKey: "test", agentModel: "gpt-4.1" } as ServerEnv,
      model: faux.getModel(), streamFn: models.streamSimple.bind(models),
      backendResult: { workspace: { read }, sandboxDir: "/tmp/test-pi-agent" } as unknown as AgentBackendResult,
      workspaceSkills: [{ name: "active", description: "Use for a blue bird.", path: "/workspace-skills/active/SKILL.md", content: "Read references/guide.md", files: [] }],
    });
    const events = [];
    for await (const event of agent.stream(
      { role: "user", content: "Paint a bird", timestamp: Date.now() },
      {}, new AbortController().signal,
    )) events.push(event);
    expect(read.mock.calls.map(([path]) => path)).toEqual([
      "/workspace-skills/active/SKILL.md",
      "/workspace-skills/active/references/guide.md",
    ]);
    expect(events.filter((event) => event.type === "tool_execution_end" && event.toolName === "read_file")[2])
      .toMatchObject({ isError: true, result: { content: [{ type: "text", text: expect.stringContaining("escapes its Skill directory") }] } });
  });

  it("routes task to a Pi video specialist while keeping direct generate_video available", async () => {
    const faux = fauxProvider();
    faux.setResponses([
      () => {
        return fauxAssistantMessage([fauxToolCall("task", { subagent_type: "video_generate", description: "Make a blue bird video" })], { stopReason: "toolUse" });
      },
      () => {
        return fauxAssistantMessage([fauxToolCall("generate_video", { title: "Blue bird", prompt: "A blue bird flying" })], { stopReason: "toolUse" });
      },
      fauxAssistantMessage("Video generation was attempted."),
      fauxAssistantMessage("I attempted the video."),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const agent = createLoomicPiAgent({
      env: { openAIApiKey: "test", agentModel: "gpt-4.1" } as ServerEnv,
      model: faux.getModel(),
      streamFn: models.streamSimple.bind(models),
      backendResult: { workspace: {}, sandboxDir: "/tmp/test-pi-agent" } as unknown as AgentBackendResult,
    });
    const events = [];
    for await (const event of agent.stream(
      { role: "user", content: "Make a blue bird video", timestamp: Date.now() },
      {}, new AbortController().signal,
    )) events.push(event);

    expect(faux.state.callCount).toBe(4);
    expect(events.some((event) => event.type === "tool_execution_end" && event.toolName === "task")).toBe(true);
    expect(events.some((event) => event.type === "tool_execution_end" && event.toolName === "generate_video" && event.toolCallId.includes(":"))).toBe(true);
  });

  it("runs a tool, streams the response, and saves the transcript", async () => {
    const faux = fauxProvider();
    const saveEntries = vi.fn().mockResolvedValue(undefined);
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("ls", { path: "/workspace" })], { stopReason: "toolUse" }),
      () => {
        expect(saveEntries).toHaveBeenCalledOnce();
        return fauxAssistantMessage([fauxText("Found the project files.")]);
      },
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const backend = {
      lsInfo: vi.fn().mockResolvedValue([{ path: "/workspace/readme.md", is_dir: false }]),
    };
    const agent = createLoomicPiAgent({
      env: { openAIApiKey: "test", agentModel: "gpt-4.1" } as ServerEnv,
      model: faux.getModel(),
      streamFn: models.streamSimple.bind(models),
      backendResult: { workspace: backend, sandboxDir: "/tmp/test-pi-agent" } as unknown as AgentBackendResult,
      persistence: {
        fileStore: {} as AgentPersistence["fileStore"],
        loadEntries: vi.fn().mockResolvedValue([]),
        saveEntries,
      },
    });

    const events = [];
    for await (const event of agent.stream(
      { role: "user", content: "List the files", timestamp: Date.now() },
      { threadId: "thread-1" },
      new AbortController().signal,
    )) events.push(event);

    expect(backend.lsInfo).toHaveBeenCalledWith("/workspace");
    expect(events.some((event) => event.type === "tool_execution_end")).toBe(true);
    expect(events.some((event) => event.type === "message_update" && event.assistantMessageEvent.type === "text_delta")).toBe(true);
    expect(saveEntries).toHaveBeenCalledTimes(2);
    expect(saveEntries.mock.calls[0]?.[0]).toBe("thread-1");
    expect(saveEntries.mock.calls[0]?.[1].some((entry: FileEntry) => entry.type === "message" && entry.message.role === "toolResult")).toBe(true);
    expect(saveEntries.mock.calls[1]?.[1].at(-1)).toMatchObject({ type: "message", message: { role: "assistant" } });
  });

  it("loads the saved transcript on the next turn", async () => {
    const faux = fauxProvider();
    const seenRoles: string[][] = [];
    faux.setResponses([
      fauxAssistantMessage("First answer"),
      (context) => {
        seenRoles.push(context.messages.map((item) => item.role));
        return fauxAssistantMessage("Second answer");
      },
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    let saved: FileEntry[] = [];
    const persistence = {
      fileStore: {} as AgentPersistence["fileStore"],
      loadEntries: vi.fn(async () => saved),
      saveEntries: vi.fn(async (_threadId: string, entries: FileEntry[]) => { saved = entries; }),
    } satisfies AgentPersistence;
    const agent = createLoomicPiAgent({
      env: { openAIApiKey: "test", agentModel: "gpt-4.1" } as ServerEnv,
      model: faux.getModel(),
      streamFn: models.streamSimple.bind(models),
      backendResult: { workspace: {}, sandboxDir: "/tmp/test-pi-agent" } as unknown as AgentBackendResult,
      persistence,
    });
    for (const content of ["First question", "Second question"]) {
      for await (const _event of agent.stream(
        { role: "user", content, timestamp: Date.now() },
        { threadId: "thread-1" },
        new AbortController().signal,
      )) { /* Consume the stream before starting another turn. */ }
    }

    expect(seenRoles).toEqual([["system", "user", "assistant", "system", "user"]]);
    expect(saved.flatMap((entry) => entry.type === "message" && entry.message.role !== "system" ? [entry.message.role] : [])).toEqual(["user", "assistant", "user", "assistant"]);
    expect(persistence.saveEntries).toHaveBeenCalledTimes(2);
  });

  it("persists Pi's compaction checkpoint and restores it on the next turn", async () => {
    const manager = SessionManager.inMemory();
    for (let index = 0; index < 4; index++) {
      manager.appendMessage({ role: "user", content: `Requirement ${index}: ${"detail ".repeat(1000)}`, timestamp: index * 2 + 1 });
      manager.appendMessage(fauxAssistantMessage(`Decision ${index}: keep the image style consistent.`));
    }
    let saved: FileEntry[] = [manager.getHeader()!, ...manager.getEntries()];
    const faux = fauxProvider();
    const mainRequests: string[] = [];
    faux.setResponses(Array.from({ length: 8 }, () => (context) => {
      const request = JSON.stringify(context.messages);
      const lastMessage = JSON.stringify(context.messages.at(-1));
      if (lastMessage.includes("## Next Steps")) {
        return fauxAssistantMessage("The user wants a consistent image style across turns.");
      }
      mainRequests.push(request);
      return fauxAssistantMessage(lastMessage.includes("Refine the image") ? "Follow-up ready." : "Image plan ready.");
    }));
    const models = createModels();
    models.setProvider(faux.provider);
    const persistence = {
      fileStore: {} as AgentPersistence["fileStore"],
      loadEntries: vi.fn(async () => saved),
      saveEntries: vi.fn(async (_threadId: string, entries: FileEntry[]) => { saved = entries; }),
    } satisfies AgentPersistence;
    const agent = createLoomicPiAgent({
      env: { openAIApiKey: "test", agentModel: "gpt-4.1" } as ServerEnv,
      model: { ...faux.getModel(), contextWindow: 4096 },
      streamFn: models.streamSimple.bind(models),
      backendResult: { workspace: {}, sandboxDir: "/tmp/test-pi-agent" } as unknown as AgentBackendResult,
      persistence,
    });
    const replies: string[] = [];
    for (const content of ["Make the image", "Refine the image"]) {
      for await (const _event of agent.stream(
        { role: "user", content, timestamp: Date.now() },
        { threadId: "thread-1" }, new AbortController().signal,
      )) {
        if (_event.type === "message_end" && _event.message.role === "assistant") {
          replies.push(_event.message.content.filter((part) => part.type === "text").map((part) => part.text).join(""));
        }
      }
    }
    expect(saved.some((entry) => entry.type === "compaction")).toBe(true);
    expect(replies).toEqual(["Image plan ready.", "Follow-up ready."]);
    expect(mainRequests).toHaveLength(2);
    const projection = SessionManager.inMemory("/tmp/test-pi-agent", undefined, saved).buildSessionContext();
    expect(saved.filter((entry) => entry.type === "compaction")).toHaveLength(2);
    expect(JSON.stringify(projection.messages)).toContain("consistent image style");
    expect(mainRequests.every((request) => request.includes("consistent image style"))).toBe(true);
  });

  it("passes a reasoning level to a reasoning-capable model", async () => {
    const faux = fauxProvider({ models: [{ id: "reasoning-test", reasoning: true }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const reasoningLevels: unknown[] = [];
    faux.setResponses([(context, options) => {
      reasoningLevels.push(options?.reasoning);
      return fauxAssistantMessage("Done");
    }]);
    const agent = createLoomicPiAgent({
      env: { openAIApiKey: "test", agentModel: "gpt-4.1" } as ServerEnv,
      model: faux.getModel(),
      streamFn: models.streamSimple.bind(models),
      backendResult: { workspace: {}, sandboxDir: "/tmp/test-pi-agent" } as unknown as AgentBackendResult,
    });
    for await (const _event of agent.stream(
      { role: "user", content: "Think", timestamp: Date.now() },
      {},
      new AbortController().signal,
    )) { /* Consume the model stream. */ }
    expect(reasoningLevels).toEqual(["medium"]);
  });

  it("passes the current reference image to Pi unchanged", async () => {
    const faux = fauxProvider();
    faux.setResponses([(context) => {
      expect(context.messages.at(-1)).toMatchObject({
        role: "user",
        content: [
          { type: "text", text: "Use this reference" },
          { type: "image", data: "image-bytes", mimeType: "image/png" },
        ],
      });
      return fauxAssistantMessage("Image noted.");
    }]);
    const models = createModels();
    models.setProvider(faux.provider);
    const agent = createLoomicPiAgent({
      env: { openAIApiKey: "test", agentModel: "gpt-4.1" } as ServerEnv,
      model: faux.getModel(), streamFn: models.streamSimple.bind(models),
      backendResult: { workspace: {}, sandboxDir: "/tmp/test-pi-agent" } as unknown as AgentBackendResult,
    });
    for await (const _event of agent.stream(
      { role: "user", content: [
        { type: "text", text: "Use this reference" },
        { type: "image", data: "image-bytes", mimeType: "image/png" },
      ], timestamp: Date.now() }, {}, new AbortController().signal,
    )) { /* Consume the run. */ }
    expect(faux.state.callCount).toBe(1);
  });

  it("retains the final model error when Pi cannot compact the session", async () => {
    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "maximum context length exceeded" }),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const agent = createLoomicPiAgent({
      env: { openAIApiKey: "test", agentModel: "gpt-4.1" } as ServerEnv,
      model: { ...faux.getModel(), contextWindow: 4096 },
      streamFn: models.streamSimple.bind(models),
      backendResult: { workspace: {}, sandboxDir: "/tmp/test-pi-agent" } as unknown as AgentBackendResult,
      persistence: {
        fileStore: {} as AgentPersistence["fileStore"],
        loadEntries: vi.fn().mockResolvedValue((() => {
          const manager = SessionManager.inMemory();
          manager.appendMessage({ role: "user", content: "old ".repeat(5000), timestamp: 1 });
          return [manager.getHeader()!, ...manager.getEntries()];
        })()),
        saveEntries: vi.fn().mockResolvedValue(undefined),
      },
    });
    const events = [];
    for await (const event of agent.stream(
      { role: "user", content: "New request", timestamp: Date.now() },
      { threadId: "thread-1" }, new AbortController().signal,
    )) events.push(event);
    expect(faux.state.callCount).toBe(1);
    expect(events.some((event) => event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "error")).toBe(true);
  });

  it("fails the run when a turn cannot be checkpointed", async () => {
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage("Done")]);
    const models = createModels();
    models.setProvider(faux.provider);
    const agent = createLoomicPiAgent({
      env: { openAIApiKey: "test", agentModel: "gpt-4.1" } as ServerEnv,
      model: faux.getModel(), streamFn: models.streamSimple.bind(models),
      backendResult: { workspace: {}, sandboxDir: "/tmp/test-pi-agent" } as unknown as AgentBackendResult,
      persistence: {
        fileStore: {} as AgentPersistence["fileStore"],
        loadEntries: vi.fn().mockResolvedValue([]),
        saveEntries: vi.fn().mockRejectedValue(new Error("Database unavailable")),
      },
    });
    await expect((async () => {
      for await (const _event of agent.stream(
        { role: "user", content: "Reply", timestamp: Date.now() },
        { threadId: "thread-1" }, new AbortController().signal,
      )) { /* Consume the run. */ }
    })()).rejects.toThrow("Database unavailable");
  });

  it("does not start a model turn when the run was already canceled", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const agent = createLoomicPiAgent({
      env: { openAIApiKey: "test", agentModel: "gpt-4.1" } as ServerEnv,
      model: faux.getModel(),
      streamFn: models.streamSimple.bind(models),
      backendResult: { workspace: {}, sandboxDir: "/tmp/test-pi-agent" } as unknown as AgentBackendResult,
    });
    const controller = new AbortController();
    controller.abort();
    const events = [];
    for await (const event of agent.stream(
      { role: "user", content: "Do not run", timestamp: Date.now() },
      {}, controller.signal,
    )) events.push(event);
    expect(events).toEqual([]);
    expect(faux.state.callCount).toBe(0);
  });
});
