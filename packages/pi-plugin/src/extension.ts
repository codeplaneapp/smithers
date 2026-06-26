import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ExtensionAPI as PiExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type, type TSchema } from "@sinclair/typebox";
import {
  createSmithersAgentContract,
  type SmithersAgentContract,
} from "@smithers-orchestrator/agents/agent-contract";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { buildSmithersPiSystemPrompt } from "./buildSmithersPiSystemPrompt.js";
import { DevToolsClient } from "./runtime/DevToolsClient.js";
import { DevToolsStore } from "./runtime/DevToolsStore.js";
import { normalizeState } from "./runtime/normalizeState.js";
import { RunInspector } from "./views/RunInspector.js";

type ExtensionAPI = PiExtensionAPI & {
  registerFlag: (name: string, config: Record<string, unknown>) => void;
  getFlag: (name: string) => string | undefined;
  on: (event: string, handler: (...args: any[]) => unknown) => void;
  registerTool: (tool: Record<string, unknown>) => void;
  registerCommand: (name: string, command: Record<string, unknown>) => void;
  registerMessageRenderer: (name: string, renderer: (...args: any[]) => unknown) => void;
  sendUserMessage: (content: string, options?: Record<string, unknown>) => void | Promise<void>;
};

type ExtensionContext = {
  hasUI?: boolean;
  ui: {
    notify: (message: string, level?: "info" | "warning" | "error") => void;
    custom: (factory: (...args: any[]) => unknown) => Promise<void>;
    input: (title: string, placeholder?: string) => Promise<string | undefined>;
    select: (title: string, options: string[]) => Promise<string | undefined>;
    confirm: (title: string, message?: string) => Promise<boolean>;
    setStatus?: (name: string, status: string | undefined) => void;
  };
};

type TrackedRun = {
  runId: string;
  workflowName: string;
  client: DevToolsClient;
  store: DevToolsStore;
};

const DEFAULT_BASE = "http://127.0.0.1:7331";
const requireFromHere = createRequire(import.meta.url);

let piRef: ExtensionAPI | undefined;
let smithersDocs: string | undefined;
let mcpClient: Client | undefined;
let mcpTransport: StdioClientTransport | undefined;
let smithersToolContract: SmithersAgentContract | undefined;
let mcpToolsRegistered = false;
let mcpToolsRegistration: Promise<void> | undefined;
let pollInterval: ReturnType<typeof setInterval> | undefined;
let activeRunId: string | undefined;
let includeSmithersDocsNextTurn = false;

const runs = new Map<string, TrackedRun>();

function getBase() {
  const value = piRef?.getFlag("smithers-url");
  return typeof value === "string" && value.length > 0 ? value : DEFAULT_BASE;
}

function getApiKey() {
  const value = piRef?.getFlag("smithers-key");
  return typeof value === "string" && value.length > 0 ? value : process.env.SMITHERS_API_KEY || undefined;
}

function loadSmithersDocs() {
  if (smithersDocs) {
    return smithersDocs;
  }
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(thisDir, "../../../docs/llms-full.txt"),
    resolve(process.cwd(), "docs/llms-full.txt"),
    resolve(process.cwd(), "node_modules/smithers-orchestrator/docs/llms-full.txt"),
  ];
  for (const candidate of candidates) {
    try {
      smithersDocs = readFileSync(candidate, "utf8");
      return smithersDocs;
    } catch {
      // try next
    }
  }
  const fallbacks = [
    resolve(thisDir, "../../../docs/llms.txt"),
    resolve(process.cwd(), "docs/llms.txt"),
    resolve(process.cwd(), "node_modules/smithers-orchestrator/docs/llms.txt"),
  ];
  for (const candidate of fallbacks) {
    try {
      smithersDocs = readFileSync(candidate, "utf8");
      return smithersDocs;
    } catch {
      // try next
    }
  }
  smithersDocs = "(Smithers docs not found - check that docs/llms-full.txt exists)";
  return smithersDocs;
}

function resolveCliPath() {
  try {
    return requireFromHere.resolve("@smithers-orchestrator/cli");
  } catch {
    return resolve(dirname(fileURLToPath(import.meta.url)), "../../../apps/cli/src/index.js");
  }
}

async function ensureMcpClient() {
  if (mcpClient) {
    return mcpClient;
  }
  mcpTransport = new StdioClientTransport({
    command: "bun",
    args: ["run", resolveCliPath(), "--mcp"],
    cwd: process.cwd(),
    stderr: "pipe",
  });
  mcpClient = new Client({ name: "smithers-pi-extension", version: "1.0.0" });
  await mcpClient.connect(mcpTransport);
  return mcpClient;
}

async function ensureSmithersToolContract() {
  if (smithersToolContract) {
    return smithersToolContract;
  }
  const client = await ensureMcpClient();
  const { tools } = await client.listTools();
  smithersToolContract = createSmithersAgentContract({
    serverName: "smithers",
    toolSurface: "semantic",
    tools: tools
      .filter((tool) => tool.name !== "tui")
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
      })),
  });
  return smithersToolContract;
}

async function callMcpTool(name: string, args: Record<string, unknown>) {
  const client = await ensureMcpClient();
  const result = await client.callTool({ name, arguments: args });
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .filter((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
  return { text, isError: result.isError === true };
}

export function jsonSchemaTypeToTypebox(node: any): TSchema {
  switch (node?.type) {
    case "number":
    case "integer":
      return Type.Number();
    case "boolean":
      return Type.Boolean();
    case "string":
      return Type.String();
    case "array":
      return Type.Array(jsonSchemaTypeToTypebox(node.items));
    case "object":
      return Type.Record(Type.String(), Type.Unknown());
    default:
      return Type.Unknown();
  }
}

export function jsonSchemaToTypebox(schema: Record<string, any>) {
  const properties = schema.properties ?? {};
  const required = new Set<string>(schema.required ?? []);
  const result: Record<string, any> = {};
  for (const [key, prop] of Object.entries<any>(properties)) {
    const opts = prop.description ? { description: prop.description } : {};
    let field;
    switch (prop.type) {
      case "number":
      case "integer":
        field = Type.Number(opts);
        break;
      case "boolean":
        field = Type.Boolean(opts);
        break;
      case "array":
        field = Type.Array(jsonSchemaTypeToTypebox(prop.items), opts);
        break;
      case "object":
        field = Type.Record(Type.String(), Type.Unknown(), opts);
        break;
      default:
        field = Type.String(opts);
    }
    result[key] = required.has(key) ? field : Type.Optional(field);
  }
  return result;
}

function statusIcon(status: string) {
  switch (status) {
    case "running":
      return ">";
    case "finished":
      return "v";
    case "failed":
      return "x";
    case "cancelled":
      return "-";
    case "waiting-approval":
      return "!";
    default:
      return "o";
  }
}

function collectNodeStates(run: TrackedRun) {
  const states: Array<{ nodeId: string; state: string }> = [];
  const walk = (node: any) => {
    if (node?.task?.nodeId) {
      states.push({
        nodeId: node.task.nodeId,
        state: typeof node.props?.state === "string" ? node.props.state : "unknown",
      });
    }
    for (const child of node?.children ?? []) {
      walk(child);
    }
  };
  walk(run.store.tree);
  return states;
}

function collectErrors(run: TrackedRun) {
  const errors: string[] = [];
  const walk = (node: any) => {
    if (node?.props?.error !== undefined) {
      errors.push(`${node.task?.nodeId ?? node.name}: ${String(node.props.error)}`);
    }
    for (const child of node?.children ?? []) {
      walk(child);
    }
  };
  walk(run.store.tree);
  return errors;
}

function trackRun(runId: string, workflowName = "workflow") {
  const existing = runs.get(runId);
  if (existing) {
    activeRunId = runId;
    return existing;
  }
  const client = new DevToolsClient({ baseUrl: getBase(), apiKey: getApiKey() });
  const store = new DevToolsStore({ client });
  const run = { runId, workflowName, client, store };
  runs.set(runId, run);
  activeRunId = runId;
  store.connect(runId);
  return run;
}

function updateStatusBar(ctx: ExtensionContext) {
  const active = [...runs.values()].filter((run) => !run.store.isRunFinished);
  const failed = [...runs.values()].filter((run) => run.store.runStatus === "failed");
  const parts: string[] = [];
  if (active.length > 0) {
    parts.push(`${active.length} active`);
  }
  if (failed.length > 0) {
    parts.push(`${failed.length} failed`);
  }
  ctx.ui.setStatus?.("smithers", parts.length > 0 ? `smithers: ${parts.join("  ")}` : undefined);
}

async function openInspector(ctx: ExtensionContext, run: TrackedRun) {
  if (!ctx.hasUI) {
    ctx.ui.notify("/smithers requires interactive mode", "error");
    return;
  }
  await ctx.ui.custom((_tui: unknown, theme: any, _kb: unknown, done: () => void) =>
    new RunInspector(run.store, run.client, {
      workflowName: run.workflowName,
      theme,
      onClose: done,
      onNotify: (message, level) => ctx.ui.notify(message, level),
    }),
  );
}

async function registerMcpTools(pi: ExtensionAPI, ctx: ExtensionContext) {
  if (mcpToolsRegistered) {
    return;
  }
  if (mcpToolsRegistration) {
    return mcpToolsRegistration;
  }
  mcpToolsRegistration = registerMcpToolsInner(pi, ctx).finally(() => {
    mcpToolsRegistration = undefined;
  });
  return mcpToolsRegistration;
}

async function registerMcpToolsInner(pi: ExtensionAPI, ctx: ExtensionContext) {
  try {
    const client = await ensureMcpClient();
    const { tools } = await client.listTools();
    smithersToolContract = createSmithersAgentContract({
      serverName: "smithers",
      toolSurface: "semantic",
      tools: tools
        .filter((tool) => tool.name !== "tui")
        .map((tool) => ({ name: tool.name, description: tool.description })),
    });

    for (const tool of tools) {
      if (tool.name === "tui") {
        continue;
      }
      pi.registerTool({
        name: `smithers_${tool.name}`,
        label: `Smithers ${tool.name}`,
        description: tool.description ?? `Run smithers ${tool.name.replace(/_/g, " ")}`,
        parameters: Type.Object(jsonSchemaToTypebox((tool.inputSchema ?? {}) as Record<string, any>)),
        async execute(_id: string, params: Record<string, unknown>) {
          const cleanParams: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(params)) {
            if (value !== undefined) {
              cleanParams[key] = value;
            }
          }
          const result = await callMcpTool(tool.name, cleanParams);
          return {
            content: [{ type: "text", text: result.text }],
            details: { tool: tool.name, isError: result.isError },
          };
        },
        renderCall(args: Record<string, unknown>, theme: any) {
          const argStr = Object.entries(args)
            .filter(([, value]) => value !== undefined)
            .map(([key, value]) => `${key}=${value}`)
            .join(" ");
          return new Text(
            theme.fg("toolTitle", theme.bold(`smithers ${tool.name.replace(/_/g, " ")} `)) +
              theme.fg("muted", argStr),
            0,
            0,
          );
        },
        renderResult(result: any, _opts: unknown, theme: any) {
          if (result.details?.isError) {
            const text = result.content?.[0];
            return new Text(theme.fg("error", `x ${text?.type === "text" ? text.text : "error"}`), 0, 0);
          }
          return new Text("", 0, 0);
        },
      });
    }
    mcpToolsRegistered = true;
  } catch (error) {
    ctx.ui.notify(`Smithers MCP: ${error instanceof Error ? error.message : String(error)}`, "warning");
  }
}

export function extension(pi: ExtensionAPI) {
  piRef = pi;

  pi.registerFlag("smithers-url", {
    description: "Smithers gateway URL (default: http://127.0.0.1:7331)",
    type: "string",
    default: DEFAULT_BASE,
  });
  pi.registerFlag("smithers-key", {
    description: "Smithers API key",
    type: "string",
    default: "",
  });

  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    // Clear any timer left over from a previous session before re-arming, so a
    // reload/session-replacement never leaves a timer holding a stale ctx.
    if (pollInterval) {
      clearInterval(pollInterval);
    }
    pollInterval = setInterval(() => {
      // ctx becomes stale after reload/newSession/fork/switchSession; touching
      // ctx.ui then throws. Stop polling instead of crashing the Pi process.
      try {
        updateStatusBar(ctx);
      } catch {
        if (pollInterval) {
          clearInterval(pollInterval);
          pollInterval = undefined;
        }
      }
    }, 5_000);
    void registerMcpTools(pi, ctx);
    updateStatusBar(ctx);
  });

  pi.on("session_shutdown", async () => {
    if (pollInterval) {
      clearInterval(pollInterval);
    }
    for (const run of runs.values()) {
      run.store.disconnect();
    }
    runs.clear();
  });

  pi.on("before_agent_start", async (event: { systemPrompt: string }) => {
    const docs = includeSmithersDocsNextTurn ? loadSmithersDocs() : undefined;
    includeSmithersDocsNextTurn = false;
    const contract = await ensureSmithersToolContract();
    const active = activeRunId ? runs.get(activeRunId) : undefined;
    return {
      systemPrompt: buildSmithersPiSystemPrompt(
        event.systemPrompt,
        docs,
        contract,
        active
          ? {
              runId: active.runId,
              workflowName: active.workflowName,
              status: active.store.runStatus,
              nodeStates: collectNodeStates(active),
              errors: collectErrors(active),
            }
          : undefined,
      ),
    };
  });

  pi.registerCommand("smithers", {
    description: "Open the Smithers live run inspector",
    handler: async (args: string, ctx: ExtensionContext) => {
      const requested = args.trim();
      let run = requested ? trackRun(requested) : activeRunId ? runs.get(activeRunId) : undefined;
      if (!run) {
        const runId = await ctx.ui.input("Run ID", "Enter the Smithers run ID to inspect");
        if (!runId) {
          return;
        }
        run = trackRun(runId);
      }
      await openInspector(ctx, run);
    },
  });

  pi.registerCommand("smithers-docs", {
    description: "Include the full Smithers docs in the next prompt, or pass a prompt to run now",
    handler: async (args: string, ctx: ExtensionContext) => {
      includeSmithersDocsNextTurn = true;
      const prompt = args.trim();
      if (prompt) {
        await pi.sendUserMessage(prompt);
        return;
      }
      ctx.ui.notify("Full Smithers docs will be included with your next prompt.", "info");
    },
  });

  pi.registerCommand("smithers-watch", {
    description: "Attach to a Smithers run devtools stream by run ID",
    getArgumentCompletions(prefix: string) {
      return [...runs.values()]
        .filter((run) => run.runId.startsWith(prefix))
        .map((run) => ({ value: run.runId, label: `${run.workflowName} (${run.runId.slice(0, 8)})` }));
    },
    handler: async (args: string, ctx: ExtensionContext) => {
      const runId = args.trim() || (await ctx.ui.input("Run ID", "Enter the Smithers run ID to watch"));
      if (!runId) {
        return;
      }
      const run = trackRun(runId);
      ctx.ui.notify(`Watching run ${runId.slice(0, 8)}`, "info");
      updateStatusBar(ctx);
      await openInspector(ctx, run);
    },
  });

  pi.registerCommand("smithers-runs", {
    description: "List tracked Smithers runs",
    handler: async (_args: string, ctx: ExtensionContext) => {
      if (runs.size === 0) {
        ctx.ui.notify("No runs tracked", "info");
        return;
      }
      const runList = [...runs.values()];
      const options = runList.map(
        (run) => `${statusIcon(run.store.runStatus)} ${run.workflowName} (${run.runId.slice(0, 8)}) - ${run.store.runStatus}`,
      );
      const selected = await ctx.ui.select("Smithers Runs", options);
      if (!selected) {
        return;
      }
      const run = runList[options.indexOf(selected)];
      activeRunId = run.runId;
      await openInspector(ctx, run);
    },
  });

  pi.registerCommand("smithers-approve", {
    description: "Approve or deny the selected waiting node",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const waiting = [...runs.values()].flatMap((run) =>
        collectNodeStates(run)
          .filter((node) => normalizeState(node.state) === "waiting-approval")
          .map((node) => ({ run, node })),
      );
      if (waiting.length === 0) {
        ctx.ui.notify("No nodes waiting for approval", "info");
        return;
      }
      const options = waiting.map((entry) => `${entry.run.workflowName} -> ${entry.node.nodeId}`);
      const selected = await ctx.ui.select("Select node", options);
      if (!selected) {
        return;
      }
      const target = waiting[options.indexOf(selected)];
      const action = await ctx.ui.select("Action", ["Approve", "Deny", "Cancel"]);
      if (!action || action === "Cancel") {
        return;
      }
      try {
        if (action === "Approve") {
          await target.run.client.approve(target.run.runId, target.node.nodeId);
        } else {
          await target.run.client.deny(target.run.runId, target.node.nodeId);
        }
      } catch (error) {
        ctx.ui.notify(
          `Failed to ${action.toLowerCase()} ${target.node.nodeId}: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
        return;
      }
      ctx.ui.notify(`${action}d ${target.node.nodeId}`, action === "Approve" ? "info" : "warning");
    },
  });

  pi.registerCommand("smithers-cancel", {
    description: "Cancel the active Smithers run",
    handler: async (args: string, ctx: ExtensionContext) => {
      const runId = args.trim() || activeRunId;
      const run = runId ? runs.get(runId) : undefined;
      if (!run) {
        ctx.ui.notify("No active run to cancel", "info");
        return;
      }
      const confirmed = await ctx.ui.confirm("Cancel run?", `Cancel run ${run.runId.slice(0, 8)}?`);
      if (!confirmed) {
        return;
      }
      try {
        await run.client.cancel(run.runId);
      } catch (error) {
        ctx.ui.notify(
          `Failed to cancel ${run.runId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
        return;
      }
      ctx.ui.notify(`Cancelling ${run.runId.slice(0, 8)}`, "warning");
    },
  });

  pi.registerCommand("smithers-run", {
    description: "Start a Smithers workflow through MCP",
    handler: async (args: string, ctx: ExtensionContext) => {
      const workflowId = args.trim() || (await ctx.ui.input("Workflow ID", "e.g. deploy (from .smithers/workflows)"));
      if (!workflowId) {
        return;
      }
      const inputText = await ctx.ui.input("Input JSON (optional)", "{}");
      const params: Record<string, unknown> = { workflowId };
      if (inputText && inputText.trim() && inputText.trim() !== "{}") {
        try {
          params.input = JSON.parse(inputText);
        } catch {
          ctx.ui.notify("Input must be valid JSON object", "error");
          return;
        }
      }
      const result = await callMcpTool("run_workflow", params);
      if (result.isError) {
        throw new SmithersError("PI_MCP_ERROR", result.text);
      }
      try {
        const parsed = JSON.parse(result.text);
        const runId = parsed?.data?.runId ?? parsed?.runId;
        if (typeof runId === "string") {
          trackRun(runId, workflowId);
          ctx.ui.notify(`Started ${workflowId} - run ${runId.slice(0, 8)}`, "info");
          return;
        }
      } catch {
        // non-json tool output
      }
      ctx.ui.notify(`Started: ${result.text}`, "info");
    },
  });

  pi.registerMessageRenderer("smithers-event", (message: any, { expanded }: any, theme: any) => {
    const details = message.details;
    if (!details) {
      return undefined;
    }
    const content =
      typeof message.content === "string"
        ? message.content
        : message.content?.map?.((part: any) => (part.type === "text" ? part.text : "[image]")).join(" ");
    let text = `${statusIcon(details.status ?? "running")} ${theme.fg("muted", content ?? "")}`;
    if (expanded && details.runId) {
      text += `\n${theme.fg("dim", `  run: ${details.runId}`)}`;
    }
    return new Text(text, 0, 0);
  });
}

export default extension;
