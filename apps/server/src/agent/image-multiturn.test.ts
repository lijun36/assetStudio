import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { FileEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import type { ServerEnv } from "../config/env.js";
import type { AgentBackendResult } from "./backends/index.js";
import type { AgentPersistence } from "./persistence/index.js";
import { createLoomicPiAgent } from "./pi-agent.js";
import { adaptPiAgentStream } from "./pi-stream-adapter.js";

const imageRequest = (prompt: string, inputImages?: string[]) => ({
  title: "Blue bird",
  prompt,
  model: "black-forest-labs/flux-kontext-pro",
  ...(inputImages ? { inputImages } : {}),
});

describe("multi-turn image generation through Pi", () => {
  it("answers a request for an image prompt as text without starting an image job", async () => {
    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage("提示词：一只蓝色小鸟站在树枝上。"),
      fauxAssistantMessage("提示词：一只蓝色小鸟飞过草地。"),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const submitImageJob = vi.fn();
    const agent = createLoomicPiAgent({
      env: { agentModel: "gpt-4.1" } as ServerEnv,
      model: faux.getModel(), streamFn: models.streamSimple.bind(models),
      backendResult: { workspace: {}, sandboxDir: "/tmp/test-pi-image" } as unknown as AgentBackendResult,
      submitImageJob,
    });
    for (const [index, prompt] of ["请给我生成图片的提示词", "请给我生成一张图的提示词"].entries()) {
      const events = [];
      for await (const event of adaptPiAgentStream({
        conversationId: "conversation-1", sessionId: "session-1", runId: `run-prompt-only-${index}`,
        stream: agent.stream({ role: "user", content: prompt, timestamp: index + 1 }, {}, new AbortController().signal),
      })) events.push(event);
      expect(events.at(-1)?.type).toBe("run.completed");
    }
    expect(faux.state.callCount).toBe(2);
    expect(submitImageJob).not.toHaveBeenCalled();
  });

  it("exposes generate_image on the first request and completes an explicit image generation", async () => {
    const faux = fauxProvider();
    faux.setResponses([
      (context) => {
        expect(getCurrentTools(context.messages).map((tool) => tool.name)).toContain("generate_image");
        return fauxAssistantMessage([fauxToolCall("generate_image", imageRequest("A blue bird"))], { stopReason: "toolUse" });
      },
      fauxAssistantMessage("The image is ready."),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const submitImageJob = vi.fn().mockResolvedValue({ jobId: "job-1", imageUrl: "https://assets.example/bird.png" });
    const agent = createLoomicPiAgent({
      env: { agentModel: "gpt-4.1" } as ServerEnv,
      model: faux.getModel(), streamFn: models.streamSimple.bind(models),
      backendResult: { workspace: {}, sandboxDir: "/tmp/test-pi-image" } as unknown as AgentBackendResult,
      submitImageJob,
    });
    const events = [];
    for await (const event of adaptPiAgentStream({
      conversationId: "conversation-1", sessionId: "session-1", runId: "run-image-required",
      stream: agent.stream({ role: "user", content: "请生成一张蓝色小鸟插画", timestamp: 1 }, {}, new AbortController().signal),
    })) events.push(event);
    expect(submitImageJob).toHaveBeenCalledOnce();
    expect(events.find((event) => event.type === "tool.completed")?.artifacts).toMatchObject([{ type: "image" }]);
    expect(events.at(-1)?.type).toBe("run.completed");
  });

  it("keeps the first result for a follow-up edit and resolves a new attachment ID", async () => {
    const firstUrl = "https://assets.example/first.png?token=valid";
    const secondUrl = "https://assets.example/second.png";
    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("generate_image", imageRequest("A blue bird"))], { stopReason: "toolUse" }),
      fauxAssistantMessage("The first image is ready."),
      (context) => {
        expect(JSON.stringify(context.messages)).toContain(firstUrl);
        return fauxAssistantMessage([fauxToolCall("generate_image", imageRequest("Make the previous bird fly", ["https://assets.example/first.png?token=corrupted"]))], { stopReason: "toolUse" });
      },
      fauxAssistantMessage("The edited image is ready."),
      (context) => {
        expect(JSON.stringify(context.messages)).toContain(secondUrl);
        expect(context.messages.at(-1)).toMatchObject({
          role: "user",
          content: expect.arrayContaining([{ type: "image", data: "YWJj", mimeType: "image/png" }]),
        });
        return fauxAssistantMessage([fauxToolCall("generate_image", imageRequest("Use the attached palette", ["asset-2"]))], { stopReason: "toolUse" });
      },
      fauxAssistantMessage("The third image is ready."),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const submitImageJob = vi.fn()
      .mockResolvedValueOnce({ jobId: "job-1", imageUrl: firstUrl, width: 1024, height: 1024 })
      .mockResolvedValueOnce({ jobId: "job-2", imageUrl: secondUrl, width: 1024, height: 1024 })
      .mockResolvedValueOnce({ jobId: "job-3", imageUrl: "https://assets.example/third.png", width: 1024, height: 1024 });
    let saved: FileEntry[] = [];
    const persistence = {
      fileStore: {} as AgentPersistence["fileStore"],
      loadEntries: vi.fn(async () => saved),
      saveEntries: vi.fn(async (_threadId: string, entries: FileEntry[]) => { saved = entries; }),
    } satisfies AgentPersistence;
    const agent = createLoomicPiAgent({
      env: { agentModel: "gpt-4.1" } as ServerEnv,
      model: faux.getModel(),
      streamFn: models.streamSimple.bind(models),
      backendResult: { workspace: {}, sandboxDir: "/tmp/test-pi-image" } as unknown as AgentBackendResult,
      persistence,
      submitImageJob,
    });

    const turns: AgentMessage[] = [
      { role: "user", content: "Generate a blue bird", timestamp: 1 },
      { role: "user", content: "Make the previous bird fly", timestamp: 2 },
      { role: "user", content: [{ type: "text", text: "Use this palette" }, { type: "image", data: "YWJj", mimeType: "image/png" }], timestamp: 3 },
    ];
    for (let index = 0; index < turns.length; index++) {
      const events = [];
      for await (const event of adaptPiAgentStream({
        conversationId: "conversation-1", sessionId: "session-1", runId: `run-${index}`,
        stream: agent.stream(turns[index]!, {
          threadId: "thread-1",
          ...(index === 2 ? { attachmentMap: { "asset-2": "data:image/png;base64,YWJj" } } : {}),
        }, new AbortController().signal),
      })) events.push(event);
      expect(events.at(-1)?.type).toBe("run.completed");
      expect(events.find((event) => event.type === "tool.completed")?.artifacts).toMatchObject([{ type: "image" }]);
    }

    expect(submitImageJob).toHaveBeenCalledTimes(3);
    expect(submitImageJob.mock.calls[0]?.[0].inputImages).toBeUndefined();
    expect(submitImageJob.mock.calls[1]?.[0].inputImages).toEqual([firstUrl]);
    expect(submitImageJob.mock.calls[2]?.[0].inputImages).toEqual(["data:image/png;base64,YWJj"]);
    expect(saved.filter((entry) => entry.type === "message" && entry.message.role === "user")).toHaveLength(3);
    expect(saved.filter((entry) => entry.type === "message" && entry.message.role === "toolResult")).toHaveLength(3);
  });

  it("lets the agent retry an image job failure within the same turn", async () => {
    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("generate_image", imageRequest("First attempt"))], { stopReason: "toolUse" }),
      (context) => {
        expect(JSON.stringify(context.messages)).toContain("provider temporarily unavailable");
        return fauxAssistantMessage([fauxToolCall("generate_image", imageRequest("Retry"))], { stopReason: "toolUse" });
      },
      fauxAssistantMessage("The retry succeeded."),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const submitImageJob = vi.fn()
      .mockResolvedValueOnce({ jobId: "job-failed", error: "provider temporarily unavailable" })
      .mockResolvedValueOnce({ jobId: "job-ok", imageUrl: "https://assets.example/retry.png" });
    const agent = createLoomicPiAgent({
      env: { agentModel: "gpt-4.1" } as ServerEnv,
      model: faux.getModel(), streamFn: models.streamSimple.bind(models),
      backendResult: { workspace: {}, sandboxDir: "/tmp/test-pi-image" } as unknown as AgentBackendResult,
      submitImageJob,
    });
    const events = [];
    for await (const event of adaptPiAgentStream({
      conversationId: "conversation-1", sessionId: "session-1", runId: "run-retry",
      stream: agent.stream({ role: "user", content: "Generate an image", timestamp: 1 }, {}, new AbortController().signal),
    })) events.push(event);

    const completed = events.filter((event) => event.type === "tool.completed");
    expect(completed).toHaveLength(2);
    expect(completed[0]).toMatchObject({ output: { error: "provider temporarily unavailable" } });
    expect(completed[0]?.artifacts).toBeUndefined();
    expect(completed[1]?.artifacts).toMatchObject([{ type: "image", url: "https://assets.example/retry.png" }]);
    expect(events.at(-1)?.type).toBe("run.completed");
  });
});
