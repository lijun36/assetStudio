import { Agent, type AgentEvent, type AgentMessage, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import { randomUUID } from "node:crypto";
import { join, posix } from "node:path";
import { AgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type FileEntry } from "@earendil-works/pi-coding-agent";
import {
  createModels,
  createProvider,
  envApiKeyAuth,
  getCurrentTools,
  normalizeContext,
  toToolDeclaration,
  type Model,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { googleVertexProvider } from "@earendil-works/pi-ai/providers/google-vertex";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { Type } from "typebox";

import { DEFAULT_AGENT_MODEL, DEFAULT_GOOGLE_AGENT_MODEL, type ServerEnv } from "../config/env.js";
import type { ConnectionManager } from "../ws/connection-manager.js";
import { createAgentTrace } from "../observability/langfuse.js";
import { createAgentBackend, type AgentBackendResult } from "./backends/index.js";
import type { AgentWorkspace } from "./backends/types.js";
import { createContextCompactor } from "./context-compaction.js";
import { discoverLocalSkills } from "./local-skills.js";
import { createPiWorkspaceTools } from "./pi-workspace-tools.js";
import { createTaskTool } from "./sub-agents.js";
import { LOOMIC_SYSTEM_PROMPT } from "./prompts/loomic-main.js";
import type { AgentPersistence } from "./persistence/index.js";
import { createMainAgentTools } from "./tools/index.js";
import type { PersistImageFn, SubmitImageJobFn } from "./tools/image-generate.js";
import type { SubmitVideoJobFn } from "./tools/video-generate.js";
import type { WorkspaceSkillEntry } from "./workspace-skills.js";

export type PiRunContext = {
  accessToken?: string;
  attachmentMap?: Record<string, string>;
  canvasId?: string;
  imageModelIds?: string[];
  runId?: string;
  sessionId?: string;
  videoModelIds?: string[];
  threadId?: string;
  userId?: string;
};

export type LoomicAgent = {
  stream(message: AgentMessage, context: PiRunContext, signal: AbortSignal): AsyncIterable<AgentEvent>;
};

export type LoomicAgentFactory = (options: {
  backendResult?: AgentBackendResult;
  brandKitId?: string | null;
  canvasId?: string;
  connectionManager?: ConnectionManager;
  createUserClient?: (accessToken: string) => any;
  env: ServerEnv;
  model?: Model<any> | string;
  persistImage?: PersistImageFn;
  persistence?: AgentPersistence;
  submitImageJob?: SubmitImageJobFn;
  submitVideoJob?: SubmitVideoJobFn;
  streamFn?: StreamFn;
  workspaceSkills?: WorkspaceSkillEntry[];
  managedSkillNames?: string[];
  discoverLocalSkills?: boolean;
}) => LoomicAgent;

/** Pi owns the model loop, tool calls, and transcript. */
export function createLoomicPiAgent(options: Parameters<LoomicAgentFactory>[0]): LoomicAgent {
  const backendResult = options.backendResult ?? createAgentBackend(options.env, options.canvasId, {
    ...(options.persistence ? { fileStore: options.persistence.fileStore } : {}),
  });
  const backend = backendResult.workspace;
  const model = typeof options.model === "object" && options.model !== null
    ? options.model
    : resolveModel(options.model ?? createDefaultModelSpecifier(options.env), options.env);
  const models = createModels();
  models.setProvider(openaiProvider());
  models.setProvider(googleProvider());
  models.setProvider(googleVertexProvider());
  if (model.provider === "openai-compat") {
    models.setProvider(createProvider({
      id: "openai-compat",
      auth: { apiKey: envApiKeyAuth("OpenAI API key", ["OPENAI_API_KEY"]) },
      models: [model],
      api: model.api === "openai-responses" ? openAIResponsesApi() : openAICompletionsApi(),
    }));
  }

  const createUserClient = options.createUserClient ?? (() => {
    throw new Error("A user client is required for canvas tools.");
  });
  return {
    async *stream(message, context, signal) {
      if (message.role !== "user") throw new Error("The Pi session requires a user message.");
      const streamFn = options.streamFn ?? models.streamSimple.bind(models);
      const savedEntries = context.threadId
        ? await options.persistence?.loadEntries(context.threadId) ?? []
        : [];
      const imageReferences = collectGeneratedImageReferences(savedEntries);
      const tools = createMainAgentTools(backend, {
        createUserClient,
        ...(options.brandKitId ? { brandKitId: options.brandKitId } : {}),
        ...(options.connectionManager ? { connectionManager: options.connectionManager } : {}),
        ...(options.persistImage ? { persistImage: options.persistImage } : {}),
        sandboxDir: backendResult.sandboxDir,
        ...(options.submitImageJob ? { submitImageJob: options.submitImageJob } : {}),
        ...(options.submitVideoJob ? { submitVideoJob: options.submitVideoJob } : {}),
        translateVideoPrompt: async (prompt) => {
          const translation = await streamFn(model, normalizeContext({
            messages: [{
              role: "user",
              content: `Translate this video scene prompt into English for Veo. Preserve every subject, count, color, action, background, camera, lighting, and exclusion. Return only the English prompt.\n\n${prompt}`,
              timestamp: Date.now(),
            }],
          }), {
            maxTokens: 512,
            ...(model.reasoning ? { reasoning: "low" } : {}),
            signal,
          });
          const response = await translation.result();
          if (response.stopReason === "error" || response.stopReason === "aborted") {
            throw new Error(response.errorMessage ?? "Video prompt translation failed.");
          }
          const englishPrompt = response.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("")
            .trim();
          if (!englishPrompt || /[\u3400-\u9fff]/u.test(englishPrompt)) {
            throw new Error("Video prompt translation did not produce English text.");
          }
          return englishPrompt;
        },
        ...(context.imageModelIds ? { imageModelIds: context.imageModelIds } : {}),
        ...(context.videoModelIds ? { videoModelIds: context.videoModelIds } : {}),
      }, {
        ...(context.accessToken ? { access_token: context.accessToken } : {}),
        ...(context.canvasId ? { canvas_id: context.canvasId } : {}),
        ...(context.userId ? { user_id: context.userId } : {}),
        user_attachment_map: { ...imageReferences, ...context.attachmentMap },
      });
      const sessionManager = SessionManager.inMemory(backendResult.sandboxDir, undefined, savedEntries);
      const compactContext = createContextCompactor(model.contextWindow, async (prompt, abortSignal) => {
        const summaryStream = await streamFn(model, normalizeContext({
          messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
        }), {
          maxTokens: 2048,
          ...(model.reasoning ? { reasoning: "low" } : {}),
          ...(abortSignal ? { signal: abortSignal } : {}),
        });
        const response = await summaryStream.result();
        if (response.stopReason === "error" || response.stopReason === "aborted") {
          throw new Error(response.errorMessage ?? "Context summarization failed.");
        }
        return response.content.filter((part) => part.type === "text").map((part) => part.text).join("");
      });
      const trace = createAgentTrace(options.env, {
        runId: context.runId ?? randomUUID(),
        sessionId: context.sessionId ?? context.threadId ?? "unknown",
        ...(context.canvasId ? { canvasId: context.canvasId } : {}),
        ...(context.threadId ? { threadId: context.threadId } : {}),
        ...(context.userId ? { userId: context.userId } : {}),
        modelId: model.id,
        input: "content" in message
          ? typeof message.content === "string" ? message.content : message.content.filter((part) => part.type === "text").map((part) => part.text).join("")
          : "",
      });
      const tracedStreamFn: StreamFn = (requestModel, requestContext, requestOptions) => {
        // AgentSession can project the initial system prompt without its tool
        // declarations. Restore the active loadout for this model request.
        const head = requestContext.messages[0];
        const activeTools = agent.state.tools;
        const modelContext = head?.role === "system" && activeTools.length > 0 && getCurrentTools(requestContext.messages).length === 0
          ? { ...requestContext, messages: [{ ...head, toolsAdded: activeTools.map(toToolDeclaration) }, ...requestContext.messages.slice(1)] }
          : requestContext;
        trace.recordModelRequest(modelContext);
        return streamFn(requestModel, modelContext, requestOptions);
      };
      const events: AgentEvent[] = [];
      let wake: (() => void) | undefined;
      const localSkills = options.discoverLocalSkills && backendResult.skillsRoot
        ? discoverLocalSkills(backendResult.skillsRoot, options.managedSkillNames)
        : [];
      const systemPrompt = buildSystemPrompt(options.brandKitId, options.workspaceSkills, localSkills);
      const mainTools = [...createPiWorkspaceTools(backend), ...createFileTools(backend), createTodoTool(), ...tools];
      const allTools = [...mainTools, createTaskTool({
        model, streamFn: tracedStreamFn, tools: mainTools, systemPrompt, transformContext: compactContext,
        onEvent(parentToolCallId, event) {
          if (event.type === "message_start" || event.type === "message_end") trace.record(event, true);
          if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
            const nested = { ...event, toolCallId: `${parentToolCallId}:${event.toolCallId}` };
            trace.record(nested, true);
            events.push(nested);
            wake?.();
          }
        },
      })];
      const agent = new Agent({
        initialState: {
          systemPrompt,
          model,
          thinkingLevel: model.reasoning ? "medium" : "off",
          messages: sessionManager.buildSessionContext().messages,
          tools: allTools,
        },
        // coding-agent's session projection emits compactionSummary entries. Its
        // converter is private, so render that entry for the model here.
        convertToLlm: (messages) => messages.flatMap((entry) => {
          if (entry.role === "compactionSummary") return [{
            role: "user" as const,
            content: [{ type: "text" as const, text: `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${entry.summary}\n</summary>` }],
            timestamp: entry.timestamp,
          }];
          return entry.role === "system" || entry.role === "user" || entry.role === "assistant" || entry.role === "toolResult"
            ? [entry] : [];
        }),
        streamFn: tracedStreamFn,
        toolExecution: "sequential",
        ...(model.reasoning && (model.provider === "google" || model.provider === "google-vertex") && model.id.includes("2.5")
          ? { thinkingBudgets: { medium: -1 } }
          : {}),
      });
      const settingsManager = SettingsManager.inMemory({
        compaction: {
          enabled: true,
          reserveTokens: Math.min(16_384, Math.max(512, Math.floor(model.contextWindow * 0.1))),
          keepRecentTokens: Math.min(20_000, Math.max(1_024, Math.floor(model.contextWindow * 0.25))),
        },
        images: { autoResize: false },
      });
      const resourceLoader = new DefaultResourceLoader({
        cwd: backendResult.sandboxDir,
        agentDir: backendResult.sandboxDir,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noContextFiles: true,
        noPromptTemplates: true,
        noThemes: true,
        systemPrompt,
      });
      await resourceLoader.reload();
      const modelRuntime = await ModelRuntime.create({
        authPath: join(backendResult.sandboxDir, ".pi-auth.json"),
        modelsPath: null,
        refreshOnCreate: false,
      });
      const apiKey = options.streamFn ? "injected-stream" : model.provider === "google"
        ? options.env.googleApiKey ?? process.env.GOOGLE_API_KEY
        : model.provider === "google-vertex" ? "vertex-runtime"
          : options.env.openAIApiKey ?? process.env.OPENAI_API_KEY;
      modelRuntime.registerProvider(model.provider, apiKey ? { apiKey } : {});
      const session = new AgentSession({
        agent, sessionManager, settingsManager, resourceLoader, modelRuntime,
        cwd: backendResult.sandboxDir,
        baseToolsOverride: Object.fromEntries(allTools.map((tool) => [tool.name, tool])),
        initialActiveToolNames: allTools.map((tool) => tool.name),
      });
      let settled = false;
      let failure: unknown;
      let pendingModelError: AgentEvent | undefined;
      let savedEntryCount = sessionManager.getEntryCount();
      const saveSession = async () => {
        if (!context.threadId || !options.persistence) return;
        await options.persistence.saveEntries(context.threadId, [sessionManager.getHeader()!, ...sessionManager.getEntries()]);
        savedEntryCount = sessionManager.getEntryCount();
      };
      agent.subscribe(async (event) => {
        trace.record(event);
        if (event.type === "message_end" && event.message.role === "assistant") {
          if (event.message.stopReason === "error") {
            pendingModelError = event;
            return;
          }
          pendingModelError = undefined;
        }
        events.push(event);
        wake?.();
        if (event.type === "turn_end" && context.threadId) {
          await saveSession();
        }
      });
      const onAbort = () => { void session.abort(); };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        signal.removeEventListener("abort", onAbort);
        session.dispose();
        await trace.finish("canceled");
        return;
      }
      const input = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
      const task = session.prompt(input.filter((part) => part.type === "text").map((part) => part.text).join("\n"), {
        images: input.filter((part) => part.type === "image"),
        expandPromptTemplates: false,
      }).then(async () => {
        if (sessionManager.getEntryCount() !== savedEntryCount) await saveSession();
        if (pendingModelError) {
          events.push(pendingModelError);
          wake?.();
        }
      }).catch((error) => {
        failure = error;
      }).finally(() => {
        settled = true;
        wake?.();
      });
      try {
        while (!settled || events.length > 0) {
          if (events.length > 0) {
            yield events.shift()!;
          } else {
            await new Promise<void>((resolve) => { wake = resolve; });
            wake = undefined;
          }
        }
        await task;
        if (failure) throw failure;
      } finally {
        signal.removeEventListener("abort", onAbort);
        if (!settled) {
          await session.abort();
          await task;
        }
        session.dispose();
        await trace.finish(signal.aborted ? "canceled" : failure || pendingModelError ? "failed" : "completed");
      }
    },
  };
}

function createFileTools(backend: AgentWorkspace): AgentTool[] {
  function fileTool<T extends Record<string, unknown>>(
    name: string,
    description: string,
    parameters: AgentTool["parameters"],
    run: (params: T) => Promise<unknown>,
  ): AgentTool {
    return {
      name, label: name, description, parameters,
      async execute(id, params) {
        const output = await run(params as T);
        let text = typeof output === "string" ? output : JSON.stringify(output);
        if (text.length > 80_000) {
          const path = `/tool-results/${id.replace(/[^a-zA-Z0-9_-]/g, "_")}.txt`;
          const saved = await backend.write(path, text);
          text = `Result was too large. Read the full result from ${path}. ${JSON.stringify(saved)}`;
        }
        return { content: [{ type: "text", text }], details: undefined };
      },
    };
  }
  const tools: AgentTool[] = [
    fileTool("ls", "List files and directories", Type.Object({ path: Type.Optional(Type.String()) }), (p) => Promise.resolve(backend.lsInfo((p.path as string | undefined) ?? "/"))),
    fileTool("read_file", "Read a file with line numbers. For a relative Skill reference, pass its source file as base_path.", Type.Object({ file_path: Type.String(), base_path: Type.Optional(Type.String()), offset: Type.Optional(Type.Number()), limit: Type.Optional(Type.Number()) }), (p) => Promise.resolve(backend.read(resolveReadPath(p.file_path as string, p.base_path as string | undefined), p.offset as number | undefined, p.limit as number | undefined))),
    fileTool("glob", "Find files by glob pattern", Type.Object({ pattern: Type.String(), path: Type.Optional(Type.String()) }), (p) => Promise.resolve(backend.globInfo(p.pattern as string, p.path as string | undefined))),
    fileTool("grep", "Search file contents", Type.Object({ pattern: Type.String(), path: Type.Optional(Type.String()), glob: Type.Optional(Type.String()) }), (p) => Promise.resolve(backend.grepRaw(p.pattern as string, p.path as string | undefined, p.glob as string | undefined))),
  ];
  return tools;
}

function resolveReadPath(filePath: string, basePath?: string): string {
  if (filePath.startsWith("/")) return filePath;
  if (!basePath) throw new Error("Relative file paths require base_path set to the referring Skill file.");
  const match = /^\/(?:workspace-skills|skills)\/[^/]+\//.exec(basePath);
  if (!match) throw new Error("base_path must be a file inside a Skill directory.");
  const resolved = posix.resolve(posix.dirname(basePath), filePath);
  if (!resolved.startsWith(match[0])) throw new Error("Relative path escapes its Skill directory.");
  return resolved;
}

function createTodoTool(): AgentTool {
  const todos: Array<{ content: string; status: "pending" | "in_progress" | "completed" }> = [];
  return {
    name: "write_todos",
    label: "Task list",
    description: "Replace the current task list with the latest status of each step.",
    parameters: Type.Object({
      todos: Type.Array(Type.Object({
        content: Type.String(),
        status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")]),
      })),
    }),
    async execute(_id, params) {
      const input = params as { todos: typeof todos };
      todos.splice(0, todos.length, ...input.todos);
      return { content: [{ type: "text", text: JSON.stringify({ todos }) }], details: undefined };
    },
  };
}

function buildSystemPrompt(brandKitId?: string | null, skills: WorkspaceSkillEntry[] = [], localSkills: ReturnType<typeof discoverLocalSkills> = []): string {
  let prompt = LOOMIC_SYSTEM_PROMPT;
  if (brandKitId) prompt += "\n\n当前项目已绑定品牌套件。在进行设计相关工作时，请先使用 get_brand_kit 工具查询品牌信息，确保设计符合品牌规范。";
  const activeSkills = [
    ...skills.map((skill) => ({ name: skill.name, description: skill.description, path: skill.path })),
    ...localSkills.map((skill) => ({ name: skill.name, description: skill.description, path: skill.filePath })),
  ];
  if (activeSkills.length > 0) {
    prompt += `\n\n## Available Skills\nWhen a task matches a Skill, read its SKILL.md with read_file before following it. Resolve relative references from the file containing the reference: pass that file as base_path to read_file.\n${activeSkills.map((skill) => `- ${skill.name}: ${skill.description} (${skill.path})`).join("\n")}`;
  }
  return prompt;
}

export function createDefaultModelSpecifier(env: Pick<ServerEnv, "agentModel">): string {
  const model = env.agentModel;
  if (model.includes(":")) return model;
  return model.startsWith("gemini-") ? `google:${model}` : `openai:${model}`;
}

/** Use server-saved tool results when the model refers to an earlier image. */
function collectGeneratedImageReferences(entries: FileEntry[]): Record<string, string> {
  const references: Record<string, string> = {};
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "generate_image") continue;
    const text = entry.message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
    try {
      const result: unknown = JSON.parse(text);
      if (!result || typeof result !== "object" || !("imageUrl" in result) || typeof result.imageUrl !== "string") continue;
      const url = new URL(result.imageUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      references[`${url.origin}${url.pathname}`] = result.imageUrl;
      if ("elementId" in result && typeof result.elementId === "string") references[result.elementId] = result.imageUrl;
    } catch {
      // Tool failures can be plain text and contain no image reference.
    }
  }
  return references;
}

function resolveModel(specifier: string, env: ServerEnv): Model<any> {
  const colon = specifier.indexOf(":");
  let provider = colon > 0 ? specifier.slice(0, colon) : "openai";
  let modelId = colon > 0 ? specifier.slice(colon + 1) : specifier;
  const googleApiKey = env.googleApiKey ?? process.env.GOOGLE_API_KEY;
  const vertexProject = env.googleVertexProject ?? process.env.GOOGLE_VERTEX_PROJECT;
  const vertexLocation = env.googleVertexLocation ?? process.env.GOOGLE_VERTEX_LOCATION;
  const hasGoogle = !!(googleApiKey || (vertexProject && vertexLocation));
  if (provider === "google" && !hasGoogle) { provider = "openai"; modelId = DEFAULT_AGENT_MODEL; }
  if (provider === "openai" && !env.openAIApiKey && !process.env.OPENAI_API_KEY && hasGoogle) { provider = "google"; modelId = DEFAULT_GOOGLE_AGENT_MODEL; }

  if (env.openAIApiKey) process.env.OPENAI_API_KEY = env.openAIApiKey;
  if (googleApiKey) process.env.GEMINI_API_KEY = googleApiKey;
  if (vertexProject) process.env.GOOGLE_CLOUD_PROJECT = vertexProject;
  if (vertexLocation) process.env.GOOGLE_CLOUD_LOCATION = vertexLocation;
  if (env.googleApplicationCredentials) process.env.GOOGLE_APPLICATION_CREDENTIALS = env.googleApplicationCredentials;

  const models = createModels();
  models.setProvider(openaiProvider());
  models.setProvider(googleProvider());
  models.setProvider(googleVertexProvider());
  if (provider === "google" && vertexProject && vertexLocation) provider = "google-vertex";
  const existing = models.getModel(provider, modelId);
  if (existing && !(env.openAIApiBase && provider === "openai")) return existing;
  const template = existing ?? models.getModel(provider, provider === "openai" ? "gpt-4o" : "gemini-2.5-flash") ?? models.getModels(provider)[0];
  if (!template) throw new Error(`Unsupported agent model provider: ${provider}`);
  if (provider !== "openai") return { ...template, id: modelId, name: modelId };
  const useResponses = modelId.startsWith("gpt-6-") || modelId.startsWith("gpt-6.");
  return {
    ...template,
    id: modelId,
    name: modelId,
    api: useResponses ? "openai-responses" : "openai-completions",
    provider: "openai-compat",
    baseUrl: env.openAIApiBase ?? "https://api.openai.com/v1",
    reasoning: modelId.startsWith("gpt-5") || modelId.startsWith("gpt-6"),
    input: ["text", "image"],
  };
}
