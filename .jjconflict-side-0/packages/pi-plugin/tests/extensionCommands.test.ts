import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { WebSocketServer } from "ws";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  extension,
  resetMcpStateForTesting,
  setDocsFileReaderForTesting,
  setMcpConnectionFactoryForTesting,
  setMcpLoggerForTesting,
} from "../src/extension.js";
import { RunInspector } from "../src/views/RunInspector.js";

// Drain the microtask queue so the fully-resolved MCP bootstrap + tool
// registration chain settles deterministically.
async function flushMicrotasks() {
  for (let i = 0; i < 25; i++) {
    await Promise.resolve();
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const plainTheme = {
  fg: (_color: string, value: string) => value,
  bold: (value: string) => value,
  dim: (value: string) => value,
};

type FakeTool = { name: string; description?: string; inputSchema?: Record<string, unknown> };

const MCP_TOOLS: FakeTool[] = [
  // `tui` is interactive-only and must be skipped by the registration loop and
  // the contract builder.
  { name: "tui", description: "Interactive TUI" },
  { name: "list_runs", description: "List runs" },
  {
    name: "run_workflow",
    // No description -> the registerTool fallback description is used.
    inputSchema: {
      type: "object",
      properties: {
        workflowId: { type: "string", description: "Workflow id" },
        count: { type: "integer" },
        flag: { type: "boolean" },
        items: { type: "array", items: { type: "string" } },
        input: { type: "object" },
        other: { type: "unknownleaf" },
      },
      required: ["workflowId"],
    },
  },
];

type CallToolImpl = (name: string, args: Record<string, unknown>) => { text: string; isError?: boolean };

let callToolImpl: CallToolImpl = () => ({ text: "ok" });

function installMcpFactory(options: { listTools?: () => { tools: FakeTool[] } } = {}) {
  setMcpConnectionFactoryForTesting(async () => {
    const transport = { close: async () => {} };
    const client = {
      async listTools() {
        return options.listTools ? options.listTools() : { tools: MCP_TOOLS };
      },
      async callTool({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) {
        const result = callToolImpl(name, args);
        return { content: [{ type: "text", text: result.text }], isError: result.isError === true };
      },
    } as unknown as Client;
    return { client, transport };
  });
}

type FakeCtx = {
  hasUI?: boolean;
  ui: {
    notify: (message: string, level?: string) => void;
    setStatus?: (name: string, status: string | undefined) => void;
    custom: (factory: (...args: any[]) => unknown) => Promise<void>;
    input: (title: string, placeholder?: string) => Promise<string | undefined>;
    select: (title: string, options: string[]) => Promise<string | undefined>;
    confirm: (title: string, message?: string) => Promise<boolean>;
  };
};

type Notice = { message: string; level?: string };

function makeCtx(overrides: Partial<FakeCtx["ui"]> & { hasUI?: boolean } = {}) {
  const notices: Notice[] = [];
  const statuses: Array<{ name: string; status: string | undefined }> = [];
  const ctx: FakeCtx = {
    hasUI: overrides.hasUI ?? false,
    ui: {
      notify: (message, level) => notices.push({ message, level }),
      setStatus: (name, status) => statuses.push({ name, status }),
      custom: overrides.custom ?? (async () => {}),
      input: overrides.input ?? (async () => undefined),
      select: overrides.select ?? (async () => undefined),
      confirm: overrides.confirm ?? (async () => false),
    },
  };
  return { ctx, notices, statuses };
}

type FakePi = {
  api: Parameters<typeof extension>[0];
  handlers: Map<string, (...args: any[]) => any>;
  commands: Map<string, any>;
  tools: any[];
  renderers: Map<string, (...args: any[]) => any>;
  flags: Record<string, string | undefined>;
  sent: string[];
};

function makeFakePi(flags: Record<string, string | undefined> = {}): FakePi {
  const handlers = new Map<string, (...args: any[]) => any>();
  const commands = new Map<string, any>();
  const tools: any[] = [];
  const renderers = new Map<string, (...args: any[]) => any>();
  const sent: string[] = [];
  const api = {
    registerFlag() {},
    getFlag(name: string) {
      return flags[name];
    },
    on(event: string, handler: (...args: any[]) => any) {
      handlers.set(event, handler);
    },
    registerTool(tool: any) {
      tools.push(tool);
    },
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
    registerMessageRenderer(name: string, renderer: (...args: any[]) => any) {
      renderers.set(name, renderer);
    },
    sendUserMessage(content: string) {
      sent.push(content);
    },
  };
  return { api: api as unknown as Parameters<typeof extension>[0], handlers, commands, tools, renderers, flags, sent };
}

// ---- Real in-memory gateway fixture (HTTP /rpc + WS devtools stream) --------

type RpcResult = { ok: boolean; payload?: unknown; error?: { code?: string; message?: string } };
type RpcHandler = (method: string, params: any) => RpcResult;

function waitingSnapshot(runId: string) {
  return {
    version: 1,
    runId,
    frameNo: 1,
    seq: 1,
    root: {
      id: 1,
      type: "workflow",
      name: "wf",
      props: { state: "waiting-approval" },
      depth: 0,
      children: [
        {
          id: 2,
          type: "task",
          name: "a",
          props: { state: "waiting-approval" },
          task: { nodeId: "task:a", kind: "compute", label: "a", iteration: 0 },
          children: [],
          depth: 1,
        },
        {
          id: 3,
          type: "task",
          name: "b",
          props: { state: "failed", error: "boom" },
          task: { nodeId: "task:b", kind: "compute", label: "b", iteration: 0 },
          children: [],
          depth: 1,
        },
      ],
    },
  };
}

async function gatewayFixture(snapshot: unknown) {
  const rpcCalls: Array<{ method: string; params: any }> = [];
  let rpc: RpcHandler = () => ({ ok: true, payload: { result: { audit_row_id: "audit-x" } } });
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    rpcCalls.push({ method: body.method, params: body.params });
    const result = rpc(body.method, body.params);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ type: "res", id: body.id, ...result }));
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => {
    ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: {} }));
    ws.on("message", (raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.method === "connect") {
        ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: {} }));
        return;
      }
      if (frame.method === "streamDevTools") {
        ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { streamId: "s1" } }));
        ws.send(
          JSON.stringify({
            type: "event",
            event: "devtools.event",
            payload: { streamId: "s1", event: { type: "snapshot", ...(snapshot as object) } },
          }),
        );
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || address === null) {
    throw new Error("expected TCP server address");
  }
  return {
    server: server as Server,
    wss,
    baseUrl: `http://127.0.0.1:${address.port}`,
    rpcCalls,
    setRpc: (handler: RpcHandler) => {
      rpc = handler;
    },
  };
}

// Poll before_agent_start until the active-run context reflects the streamed
// snapshot (its failed node's error text appears), proving collectNodeStates /
// collectErrors ran over a real, populated store.
async function waitForActiveRunPopulated(beforeAgentStart: (...args: any[]) => any) {
  for (let i = 0; i < 200; i++) {
    const result = await beforeAgentStart({ systemPrompt: "BASE" });
    if (result.systemPrompt.includes("task:b: boom")) {
      return result.systemPrompt as string;
    }
    await sleep(10);
  }
  throw new Error("active run never populated from the gateway stream");
}

describe("pi-plugin extension commands", () => {
  const servers: Server[] = [];

  beforeEach(() => {
    resetMcpStateForTesting();
    setMcpLoggerForTesting(undefined);
    setDocsFileReaderForTesting(undefined);
    callToolImpl = () => ({ text: "ok" });
    installMcpFactory();
  });

  afterEach(async () => {
    // The `runs` map, activeRunId, poll timer and MCP connection are module
    // singletons; a fresh extension()'s session_shutdown handler clears them so
    // no run (or its now-dead gateway client) leaks into the next test.
    const cleanup = makeFakePi();
    extension(cleanup.api);
    await cleanup.handlers.get("session_shutdown")!();
    resetMcpStateForTesting();
    setMcpConnectionFactoryForTesting(undefined);
    setMcpLoggerForTesting(undefined);
    setDocsFileReaderForTesting(undefined);
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  async function boot(flags: Record<string, string | undefined>) {
    const pi = makeFakePi(flags);
    extension(pi.api);
    return pi;
  }

  test("session_start registers MCP tools (skipping tui) and updates an empty status bar", async () => {
    const pi = await boot({});
    const start = pi.handlers.get("session_start")!;
    const shutdown = pi.handlers.get("session_shutdown")!;
    const { ctx, statuses } = makeCtx();

    await start(undefined, ctx);
    await flushMicrotasks();

    const names = pi.tools.map((tool) => tool.name);
    expect(names).toContain("smithers_list_runs");
    expect(names).toContain("smithers_run_workflow");
    expect(names).not.toContain("smithers_tui");
    // No tracked runs -> status is cleared (undefined).
    expect(statuses.at(-1)).toEqual({ name: "smithers", status: undefined });

    // Second session_start is a no-op registration (already registered branch).
    const before = pi.tools.length;
    await start(undefined, ctx);
    await flushMicrotasks();
    expect(pi.tools.length).toBe(before);

    await shutdown();
  });

  test("a registered smithers tool executes, renders its call and error result", async () => {
    const pi = await boot({});
    const start = pi.handlers.get("session_start")!;
    const shutdown = pi.handlers.get("session_shutdown")!;
    const { ctx } = makeCtx();
    await start(undefined, ctx);
    await flushMicrotasks();

    const runTool = pi.tools.find((tool) => tool.name === "smithers_run_workflow")!;
    expect(runTool.description).toContain("run workflow"); // fallback description (no MCP description).

    callToolImpl = (name, args) => {
      expect(name).toBe("run_workflow");
      // undefined-valued params are stripped before the MCP call.
      expect(args).toEqual({ workflowId: "deploy" });
      return { text: "started", isError: false };
    };
    const execResult = await runTool.execute("id-1", { workflowId: "deploy", skip: undefined });
    expect(execResult.content[0].text).toBe("started");
    expect(execResult.details).toEqual({ tool: "run_workflow", isError: false });

    // renderCall drops undefined args and prints the remaining ones.
    const callText = runTool.renderCall({ workflowId: "deploy", skip: undefined }, plainTheme);
    expect(String((callText as any).text ?? "")).toContain("run workflow");
    expect(String((callText as any).text ?? "")).toContain("workflowId=deploy");

    // renderResult: error result renders the error text; a clean result renders empty.
    const errText = runTool.renderResult(
      { details: { isError: true }, content: [{ type: "text", text: "kaboom" }] },
      {},
      plainTheme,
    );
    expect(String((errText as any).text ?? "")).toContain("kaboom");
    const okText = runTool.renderResult({ details: { isError: false }, content: [] }, {}, plainTheme);
    expect(String((okText as any).text ?? "")).toBe("");

    await shutdown();
  });

  test("registerMcpTools notifies a warning when the MCP tool list cannot be fetched", async () => {
    installMcpFactory({
      listTools: () => {
        throw new Error("mcp down");
      },
    });
    const pi = await boot({});
    const start = pi.handlers.get("session_start")!;
    const shutdown = pi.handlers.get("session_shutdown")!;
    const { ctx, notices } = makeCtx();

    await start(undefined, ctx);
    await flushMicrotasks();

    expect(notices.some((n) => n.level === "warning" && n.message.includes("mcp down"))).toBe(true);
    await shutdown();
  });

  test("before_agent_start includes docs on demand and surfaces active-run context", async () => {
    const fixture = await gatewayFixture(waitingSnapshot("run-x"));
    servers.push(fixture.server);
    const pi = await boot({ "smithers-url": fixture.baseUrl, "smithers-key": "test-key" });
    const shutdown = pi.handlers.get("session_shutdown")!;
    const beforeAgentStart = pi.handlers.get("before_agent_start")!;
    const watch = pi.commands.get("smithers-watch");

    const { ctx } = makeCtx();
    // Track the run so it becomes the active run for the prompt context.
    await watch.handler("run-x", ctx);

    const prompt = await waitForActiveRunPopulated(beforeAgentStart);
    expect(prompt).toContain("Run: run-x");
    expect(prompt).toContain("Status: waiting-approval");
    expect(prompt).toContain("Nodes waiting approval: task:a");
    expect(prompt).toContain("Recent errors: task:b: boom");
    // The MCP contract guidance is present (cached contract path).
    expect(prompt).toContain("### Tools (available to you, the agent)");

    // /smithers-docs (no prompt) arms the next-turn docs include.
    const docs = pi.commands.get("smithers-docs");
    const { ctx: docsCtx, notices } = makeCtx();
    await docs.handler("", docsCtx);
    expect(notices.some((n) => n.message.includes("next prompt"))).toBe(true);

    const withDocs = await beforeAgentStart({ systemPrompt: "BASE" });
    expect(withDocs.systemPrompt).toContain("## Full Smithers Docs (explicitly requested)");
    // The flag is consumed -> the following turn omits the docs bundle again.
    const withoutDocs = await beforeAgentStart({ systemPrompt: "BASE" });
    expect(withoutDocs.systemPrompt).not.toContain("## Full Smithers Docs (explicitly requested)");

    await shutdown();
  });

  test("/smithers-docs with a prompt sends it as a user message", async () => {
    const pi = await boot({});
    const docs = pi.commands.get("smithers-docs");
    const { ctx } = makeCtx();
    await docs.handler("explain replay", ctx);
    expect(pi.sent).toEqual(["explain replay"]);
  });

  test("/smithers-approve approves, denies, reports no-waiting, and surfaces failures", async () => {
    const fixture = await gatewayFixture(waitingSnapshot("run-x"));
    servers.push(fixture.server);
    const pi = await boot({ "smithers-url": fixture.baseUrl });
    const shutdown = pi.handlers.get("session_shutdown")!;
    const beforeAgentStart = pi.handlers.get("before_agent_start")!;
    const watch = pi.commands.get("smithers-watch");
    const approve = pi.commands.get("smithers-approve");

    const { ctx } = makeCtx();
    await watch.handler("run-x", ctx);
    await waitForActiveRunPopulated(beforeAgentStart);

    // Approve the single waiting node.
    const approveCtx = makeCtx({
      select: async (title, options) => (title === "Action" ? "Approve" : options[0]),
    });
    await approve.handler("", approveCtx.ctx);
    expect(approveCtx.notices.some((n) => n.message === "Approved task:a" && n.level === "info")).toBe(true);
    expect(fixture.rpcCalls.some((c) => c.method === "approvals.decide" && c.params.approved === true)).toBe(true);

    // Deny path.
    const denyCtx = makeCtx({ select: async (title, options) => (title === "Action" ? "Deny" : options[0]) });
    await approve.handler("", denyCtx.ctx);
    expect(denyCtx.notices.some((n) => n.message === "Denied task:a" && n.level === "warning")).toBe(true);

    // Cancelling the action select is a no-op.
    const cancelCtx = makeCtx({ select: async (title, options) => (title === "Action" ? "Cancel" : options[0]) });
    await approve.handler("", cancelCtx.ctx);
    expect(cancelCtx.notices).toHaveLength(0);

    // Declining the node select is a no-op too.
    const skipCtx = makeCtx({ select: async () => undefined });
    await approve.handler("", skipCtx.ctx);
    expect(skipCtx.notices).toHaveLength(0);

    // A failing gateway decide surfaces an error notice.
    fixture.setRpc(() => ({ ok: false, error: { code: "DENIED", message: "no" } }));
    const errCtx = makeCtx({ select: async (title, options) => (title === "Action" ? "Approve" : options[0]) });
    await approve.handler("", errCtx.ctx);
    expect(errCtx.notices.some((n) => n.level === "error" && n.message.includes("Failed to approve"))).toBe(true);

    await shutdown();
  });

  test("/smithers-approve reports when nothing is waiting", async () => {
    const pi = await boot({});
    const approve = pi.commands.get("smithers-approve");
    const { ctx, notices } = makeCtx();
    await approve.handler("", ctx);
    expect(notices.some((n) => n.message === "No nodes waiting for approval")).toBe(true);
  });

  test("/smithers-runs lists tracked runs, opens the inspector, and reports empty", async () => {
    const fixture = await gatewayFixture(waitingSnapshot("run-x"));
    servers.push(fixture.server);
    const pi = await boot({ "smithers-url": fixture.baseUrl });
    const shutdown = pi.handlers.get("session_shutdown")!;
    const beforeAgentStart = pi.handlers.get("before_agent_start")!;
    const watch = pi.commands.get("smithers-watch");
    const runsCmd = pi.commands.get("smithers-runs");

    // Empty first.
    const emptyCtx = makeCtx();
    await runsCmd.handler("", emptyCtx.ctx);
    expect(emptyCtx.notices.some((n) => n.message === "No runs tracked")).toBe(true);

    const { ctx } = makeCtx();
    await watch.handler("run-x", ctx);
    await waitForActiveRunPopulated(beforeAgentStart);

    // Selecting nothing returns early.
    const noSelect = makeCtx({ select: async () => undefined });
    await runsCmd.handler("", noSelect.ctx);

    // Selecting the run opens the inspector under a UI-capable ctx.
    let built: unknown;
    const openCtx = makeCtx({
      hasUI: true,
      select: async (_title, options) => options[0],
      custom: async (factory) => {
        built = factory(null, plainTheme, null, () => {});
      },
    });
    await runsCmd.handler("", openCtx.ctx);
    expect(built).toBeInstanceOf(RunInspector);

    await shutdown();
  });

  test("/smithers-cancel confirms, cancels, declines, reports missing, and surfaces failure", async () => {
    const fixture = await gatewayFixture(waitingSnapshot("run-x"));
    servers.push(fixture.server);
    const pi = await boot({ "smithers-url": fixture.baseUrl });
    const shutdown = pi.handlers.get("session_shutdown")!;
    const beforeAgentStart = pi.handlers.get("before_agent_start")!;
    const watch = pi.commands.get("smithers-watch");
    const cancel = pi.commands.get("smithers-cancel");

    // No such run.
    const missing = makeCtx();
    await cancel.handler("nope", missing.ctx);
    expect(missing.notices.some((n) => n.message === "No active run to cancel")).toBe(true);

    const { ctx } = makeCtx();
    await watch.handler("run-x", ctx);
    await waitForActiveRunPopulated(beforeAgentStart);

    // Declining the confirmation is a no-op.
    const declined = makeCtx({ confirm: async () => false });
    await cancel.handler("run-x", declined.ctx);
    expect(declined.notices).toHaveLength(0);

    // Confirming cancels through the gateway (active run via empty args).
    const confirmed = makeCtx({ confirm: async () => true });
    await cancel.handler("", confirmed.ctx);
    expect(confirmed.notices.some((n) => n.message.startsWith("Cancelling"))).toBe(true);
    expect(fixture.rpcCalls.some((c) => c.method === "runs.cancel")).toBe(true);

    // A failing cancel RPC surfaces an error notice.
    fixture.setRpc(() => ({ ok: false, error: { code: "LOCKED", message: "locked" } }));
    const failed = makeCtx({ confirm: async () => true });
    await cancel.handler("run-x", failed.ctx);
    expect(failed.notices.some((n) => n.level === "error" && n.message.includes("Failed to cancel"))).toBe(true);

    await shutdown();
  });

  test("/smithers opens the inspector by arg, by active run, and prompts for a run id", async () => {
    const fixture = await gatewayFixture(waitingSnapshot("run-x"));
    servers.push(fixture.server);
    const pi = await boot({ "smithers-url": fixture.baseUrl });
    const shutdown = pi.handlers.get("session_shutdown")!;
    const smithers = pi.commands.get("smithers");

    // hasUI false -> openInspector notifies it needs interactive mode.
    const nonInteractive = makeCtx({ hasUI: false });
    await smithers.handler("run-x", nonInteractive.ctx);
    expect(nonInteractive.notices.some((n) => n.message.includes("requires interactive mode"))).toBe(true);

    // No arg and no run tracked -> prompt returns nothing -> early return.
    await shutdown(); // clear the run tracked above
    const promptNone = makeCtx({ input: async () => undefined });
    await smithers.handler("", promptNone.ctx);
    expect(promptNone.notices).toHaveLength(0);

    // No arg, prompt yields a run id -> tracks + opens under UI.
    let opened = false;
    const promptId = makeCtx({
      hasUI: true,
      input: async () => "run-x",
      custom: async (factory) => {
        factory(null, plainTheme, null, () => {});
        opened = true;
      },
    });
    await smithers.handler("", promptId.ctx);
    expect(opened).toBe(true);

    await pi.handlers.get("session_shutdown")!();
  });

  test("/smithers-watch prompts when no id is given and completes tracked run ids", async () => {
    const fixture = await gatewayFixture(waitingSnapshot("run-x"));
    servers.push(fixture.server);
    const pi = await boot({ "smithers-url": fixture.baseUrl });
    const shutdown = pi.handlers.get("session_shutdown")!;
    const watch = pi.commands.get("smithers-watch");

    // Empty args + declined input prompt -> early return.
    const declined = makeCtx({ input: async () => undefined });
    await watch.handler("", declined.ctx);
    expect(declined.notices).toHaveLength(0);

    // Prompted id is tracked and announced.
    const prompted = makeCtx({ input: async () => "run-x" });
    await watch.handler("", prompted.ctx);
    expect(prompted.notices.some((n) => n.message.includes("Watching run"))).toBe(true);

    // Argument completion offers the tracked run id, filtered by prefix.
    const completions = watch.getArgumentCompletions("run-");
    expect(completions.some((c: any) => c.value === "run-x")).toBe(true);
    expect(watch.getArgumentCompletions("zzz")).toHaveLength(0);

    await shutdown();
  });

  test("/smithers-run starts a workflow through MCP and tracks the returned run", async () => {
    const fixture = await gatewayFixture(waitingSnapshot("run-y"));
    servers.push(fixture.server);
    const pi = await boot({ "smithers-url": fixture.baseUrl });
    const shutdown = pi.handlers.get("session_shutdown")!;
    const run = pi.commands.get("smithers-run");

    // Declined workflow id -> early return.
    const noId = makeCtx({ input: async () => undefined });
    await run.handler("", noId.ctx);
    expect(noId.notices).toHaveLength(0);

    // Invalid input JSON -> error notice.
    const badJson = makeCtx({
      input: async (title: string) => (title.startsWith("Workflow") ? "deploy" : "not json"),
    });
    await run.handler("", badJson.ctx);
    expect(badJson.notices.some((n) => n.message.includes("valid JSON"))).toBe(true);

    // Happy path: MCP returns a run id which is tracked and announced.
    callToolImpl = (name, args) => {
      expect(name).toBe("run_workflow");
      expect(args.workflowId).toBe("deploy");
      expect(args.input).toEqual({ a: 1 });
      return { text: JSON.stringify({ data: { runId: "run-y" } }) };
    };
    const ok = makeCtx({
      input: async (title: string) => (title.startsWith("Workflow") ? "deploy" : '{"a":1}'),
    });
    await run.handler("", ok.ctx);
    expect(ok.notices.some((n) => n.message.includes("Started deploy"))).toBe(true);

    // Non-JSON tool output falls back to the raw-text announcement.
    callToolImpl = () => ({ text: "queued" });
    const raw = makeCtx({ input: async (title: string) => (title.startsWith("Workflow") ? "deploy" : "{}") });
    await run.handler("", raw.ctx);
    expect(raw.notices.some((n) => n.message === "Started: queued")).toBe(true);

    // An error result throws a SmithersError.
    callToolImpl = () => ({ text: "explosion", isError: true });
    const err = makeCtx({ input: async (title: string) => (title.startsWith("Workflow") ? "deploy" : "{}") });
    await expect(run.handler("", err.ctx)).rejects.toMatchObject({ code: "PI_MCP_ERROR" });

    await shutdown();
  });

  test("the smithers-event message renderer covers every status icon and content shape", async () => {
    const pi = await boot({});
    const render = pi.renderers.get("smithers-event")!;

    // No details -> nothing to render.
    expect(render({ content: "x" }, { expanded: false }, plainTheme)).toBeUndefined();

    // String content, expanded, with a run id -> two lines, running icon.
    const running = render(
      { content: "step done", details: { status: "running", runId: "run-1" } },
      { expanded: true },
      plainTheme,
    );
    expect(String((running as any).text)).toContain(">");
    expect(String((running as any).text)).toContain("run: run-1");

    // Array content, collapsed, exercises each remaining status icon.
    for (const status of ["finished", "failed", "cancelled", "waiting-approval", "queued"]) {
      const out = render(
        { content: [{ type: "text", text: "hi" }, { type: "image" }], details: { status } },
        { expanded: false },
        plainTheme,
      );
      expect(String((out as any).text)).toContain("hi");
    }
  });

  test("getBase/getApiKey fall back to defaults when flags are unset", async () => {
    // No smithers-url / smithers-key flags -> the DEFAULT_BASE + env fallbacks
    // are taken. The store connects to the unreachable default and is torn down
    // on shutdown before it can retry.
    const prev = process.env.SMITHERS_API_KEY;
    process.env.SMITHERS_API_KEY = "env-key";
    const pi = await boot({});
    const shutdown = pi.handlers.get("session_shutdown")!;
    const watch = pi.commands.get("smithers-watch");
    const { ctx } = makeCtx();
    await watch.handler("run-default", ctx);
    await flushMicrotasks();
    await shutdown();
    if (prev === undefined) {
      delete process.env.SMITHERS_API_KEY;
    } else {
      process.env.SMITHERS_API_KEY = prev;
    }
  });

  test("loadSmithersDocs caches, falls through candidates, and reports a not-found bundle", async () => {
    const pi = await boot({});
    const docs = pi.commands.get("smithers-docs");
    const beforeAgentStart = pi.handlers.get("before_agent_start")!;
    const shutdown = pi.handlers.get("session_shutdown")!;

    // First candidate throws, a later candidate succeeds -> the "try next" catch runs.
    let calls = 0;
    setDocsFileReaderForTesting((path) => {
      calls += 1;
      if (calls === 1) {
        throw new Error("missing");
      }
      return `DOCS FROM ${path}`;
    });
    await docs.handler("", makeCtx().ctx);
    const found = await beforeAgentStart({ systemPrompt: "BASE" });
    expect(found.systemPrompt).toContain("DOCS FROM");
    const callsAfterLoad = calls;

    // A second docs turn reuses the cached bundle without re-reading any file.
    await docs.handler("", makeCtx().ctx);
    const cached = await beforeAgentStart({ systemPrompt: "BASE" });
    expect(cached.systemPrompt).toContain("DOCS FROM");
    expect(calls).toBe(callsAfterLoad);

    // Every candidate throws -> the not-found sentinel bundle is used.
    setDocsFileReaderForTesting(() => {
      throw new Error("missing");
    });
    await docs.handler("", makeCtx().ctx);
    const notFound = await beforeAgentStart({ systemPrompt: "BASE" });
    expect(notFound.systemPrompt).toContain("Smithers docs not found");

    await shutdown();
  });

  test("the status bar reports a failed run, and openInspector routes inspector notices", async () => {
    const failed = waitingSnapshot("run-f");
    (failed.root.props as { state: string }).state = "failed";
    const fixture = await gatewayFixture(failed);
    servers.push(fixture.server);
    const pi = await boot({ "smithers-url": fixture.baseUrl });
    const shutdown = pi.handlers.get("session_shutdown")!;
    const beforeAgentStart = pi.handlers.get("before_agent_start")!;
    const watch = pi.commands.get("smithers-watch");

    const { ctx, statuses } = makeCtx();
    await watch.handler("run-f", ctx);
    await waitForActiveRunPopulated(beforeAgentStart);

    // Re-watch (existing run) recomputes the status bar; the failed run shows.
    await watch.handler("run-f", ctx);
    expect(statuses.some((s) => s.status?.includes("failed"))).toBe(true);

    // Open the inspector under a UI ctx and drive an action that notifies (no
    // selected node -> the inspector's onNotify -> ctx.ui.notify).
    const smithers = pi.commands.get("smithers");
    const uiNotices: Notice[] = [];
    const uiCtx: FakeCtx = {
      hasUI: true,
      ui: {
        notify: (message, level) => uiNotices.push({ message, level }),
        setStatus: () => {},
        input: async () => undefined,
        select: async () => undefined,
        confirm: async () => false,
        custom: async (factory) => {
          const inspector = factory(null, plainTheme, null, () => {}) as { handleInput: (k: string) => void };
          inspector.handleInput("a");
        },
      },
    };
    await smithers.handler("run-f", uiCtx);
    await sleep(10);
    expect(uiNotices.length).toBeGreaterThan(0);

    await shutdown();
  });

  test("the session poll interval refreshes the status bar and self-clears on a stale ctx", async () => {
    // Capture the interval callback instead of waiting on the real 5s timer.
    const realSetInterval = globalThis.setInterval;
    const realClearInterval = globalThis.clearInterval;
    let intervalCb: (() => void) | undefined;
    let cleared = 0;
    globalThis.setInterval = ((cb: () => void) => {
      intervalCb = cb;
      return 42 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    globalThis.clearInterval = (() => {
      cleared += 1;
    }) as typeof clearInterval;

    let throwOnStatus = false;
    try {
      const pi = await boot({});
      const start = pi.handlers.get("session_start")!;
      const shutdown = pi.handlers.get("session_shutdown")!;
      const ctx: FakeCtx = {
        hasUI: false,
        ui: {
          notify: () => {},
          setStatus: () => {
            if (throwOnStatus) {
              throw new Error("stale ctx");
            }
          },
          input: async () => undefined,
          select: async () => undefined,
          confirm: async () => false,
          custom: async () => {},
        },
      };
      await start(undefined, ctx);
      await flushMicrotasks();
      expect(intervalCb).toBeDefined();

      // A healthy tick refreshes the status bar (try branch).
      intervalCb!();

      // A stale ctx makes updateStatusBar throw; the catch clears the timer.
      throwOnStatus = true;
      intervalCb!();
      expect(cleared).toBeGreaterThan(0);

      throwOnStatus = false;
      await shutdown();
    } finally {
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
    }
  });
});
