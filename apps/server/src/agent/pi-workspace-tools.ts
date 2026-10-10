import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";

import type { AgentWorkspace } from "./backends/types.js";

/** Use Pi's coding tools with project-scoped file and shell operations. */
export function createPiWorkspaceTools(backend: AgentWorkspace) {
  const readFile = async (path: string) => Buffer.from(await backend.readRaw(path), "utf8");
  const write = createWriteTool("/", {
    operations: {
      mkdir: async () => {}, // The virtual workspace has no directory objects.
      writeFile: async (path, content) => {
        const result = await backend.write(path, content) as { error?: string };
        if (result.error) throw new Error(result.error);
      },
    },
  });
  write.description = "Create a new file in the project workspace. Use edit to change an existing file.";
  return [
    createReadTool("/", {
      operations: {
        readFile,
        access: async (path) => { await backend.readRaw(path); },
      },
    }),
    createBashTool("/", {
      operations: {
        exec: async (command, _cwd, { onData, signal, timeout }) => {
          const result = await backend.execute(command, {
            ...(signal ? { signal } : {}),
            ...(timeout ? { timeoutMs: timeout } : {}),
          }) as { output: string; exitCode: number | null; truncated?: boolean };
          if (signal?.aborted) throw new Error("Command aborted");
          onData(Buffer.from(result.output + (result.truncated ? "\n[Output truncated by sandbox limit]" : "")));
          return { exitCode: result.exitCode ?? 1 };
        },
      },
    }),
    createEditTool("/", {
      operations: {
        readFile,
        access: async (path) => { await backend.readRaw(path); },
        writeFile: (path, content) => backend.overwrite(path, content),
      },
    }),
    write,
  ] as const;
}
