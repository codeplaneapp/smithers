import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Effect } from "effect";
import { Cli, z } from "incur";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureSmithersTables } from "@smthrs/db/ensure";
import { SmithersDb } from "@smthrs/db/adapter";
import { captureSnapshot } from "@smthrs/time-travel/snapshot";
import { parseMcpSurfaceArgv } from "../src/argv-utils.js";
import { registerRawToolsOnMcpServer, runMcpModeIfRequested } from "../src/mcp/mcp-mode.js";
import { createSemanticMcpServer, registerSemanticTools } from "../src/mcp/semantic-server.js";
import { createSemanticToolDefinitions, SEMANTIC_TOOL_NAMES } from "../src/mcp/semantic-tools.js";
const servers = [];
const clients = [];
const tempDirs = [];
afterEach(async () => {
  while (clients.length > 0) {
    const client = clients.pop();
    if (client) {
      await client.close();
    }
  }
  while (servers.length > 0) {
    const server = servers.pop();
    if (server) {
      await server.close();
    }
  }
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});
function tempCwd() {
  const root = join(process.cwd(), "tmp", "verification");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, "smithers-semantic-mcp-"));
  tempDirs.push(dir);
  return dir;
}

function stringEnv(overrides = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  return { ...env, ...overrides };
}

async function withSqliteBackend(fn) {
  const previous = process.env.SMITHERS_BACKEND;
  process.env.SMITHERS_BACKEND = "sqlite";
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.SMITHERS_BACKEND;
    else process.env.SMITHERS_BACKEND = previous;
  }
}

async function connectSelectedSemanticTools(cwd, names) {
  const server = createSemanticMcpServer({
    name: "smithers-test",
    version: "test",
    allowedTools: [],
  });
  // The integration worktree itself lives below `.smithers/`, so normal
  // workspace discovery intentionally ignores nested fixture anchors. Use
  // the semantic surface's database seam to keep these real SQLite fixtures
  // scoped to their own temporary workspace.
  const definitions = createSemanticToolDefinitions({
    cwd: () => cwd,
    openDb: async () => {
      const dbPath = join(cwd, "smithers.db");
      const sqlite = new Database(dbPath);
      const db = drizzle(sqlite);
      return {
        adapter: new SmithersDb(db),
        dbPath,
        cleanup: () => sqlite.close(),
      };
    },
  }).filter((tool) => names.includes(tool.name));
  registerSemanticTools(server, definitions);
  servers.push(server);
  const client = new Client({
    name: "smithers-real-db-semantic-test-client",
    version: "test",
  });
  clients.push(client);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function expectToolOk(result) {
  expect(result.structuredContent?.ok).toBe(true);
  expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
  return result.structuredContent.data;
}

function expectToolError(result, code) {
  expect(result.isError).toBe(true);
  expect(result.structuredContent?.ok).toBe(false);
  expect(result.structuredContent?.error?.code).toBe(code);
  expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
  return result.structuredContent.error;
}

async function seedSemanticDb(cwd) {
  mkdirSync(join(cwd, ".smithers"), { recursive: true });
  const sqlite = new Database(join(cwd, "smithers.db"));
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  const adapter = new SmithersDb(db);
  const now = Date.UTC(2026, 0, 2, 3, 4, 5);
  try {
    await Effect.runPromise(
      adapter.insertRun({
        runId: "semantic-run",
        workflowName: "deploy-flow",
        workflowPath: join(cwd, ".smithers", "workflows", "deploy-flow.tsx"),
        parentRunId: null,
        status: "waiting-approval",
        createdAtMs: now - 10_000,
        startedAtMs: now - 9_000,
        finishedAtMs: null,
        heartbeatAtMs: now - 500,
        configJson: JSON.stringify({ gatewayWorkflowKey: "deploy-flow", mode: "integration" }),
      }),
    );
    await Effect.runPromise(
      adapter.insertRun({
        runId: "finished-run",
        workflowName: "deploy-flow",
        workflowPath: join(cwd, ".smithers", "workflows", "deploy-flow.tsx"),
        parentRunId: null,
        status: "finished",
        createdAtMs: now - 20_000,
        startedAtMs: now - 19_000,
        finishedAtMs: now - 18_000,
        heartbeatAtMs: now - 18_500,
      }),
    );
    await Effect.runPromise(
      adapter.insertRun({
        runId: "running-run",
        workflowName: "deploy-flow",
        workflowPath: join(cwd, ".smithers", "workflows", "deploy-flow.tsx"),
        parentRunId: null,
        status: "running",
        createdAtMs: now - 5_000,
        startedAtMs: now - 4_000,
        finishedAtMs: null,
        heartbeatAtMs: now - 200,
      }),
    );
    await Effect.runPromise(
      adapter.insertRun({
        runId: "failed-run",
        workflowName: "deploy-flow",
        workflowPath: join(cwd, ".smithers", "workflows", "deploy-flow.tsx"),
        parentRunId: null,
        status: "failed",
        createdAtMs: now - 15_000,
        startedAtMs: now - 14_000,
        finishedAtMs: now - 13_000,
        heartbeatAtMs: now - 13_000,
        errorJson: JSON.stringify({ message: "deployment failed" }),
      }),
    );
    await Effect.runPromise(
      adapter.insertNode({
        runId: "semantic-run",
        nodeId: "approval-gate",
        iteration: 0,
        state: "waiting-approval",
        lastAttempt: null,
        updatedAtMs: now - 8_000,
        outputTable: "",
        label: "Approval Gate",
      }),
    );
    await Effect.runPromise(
      adapter.insertNode({
        runId: "semantic-run",
        nodeId: "artifact-node",
        iteration: 0,
        state: "finished",
        lastAttempt: 1,
        updatedAtMs: now - 7_000,
        outputTable: "semantic_output",
        label: "Artifact Node",
      }),
    );
    await Effect.runPromise(
      adapter.insertNode({
        runId: "finished-run",
        nodeId: "done",
        iteration: 0,
        state: "finished",
        lastAttempt: 1,
        updatedAtMs: now - 18_000,
        outputTable: "",
        label: "Done",
      }),
    );
    await Effect.runPromise(
      adapter.insertAttempt({
        runId: "semantic-run",
        nodeId: "artifact-node",
        iteration: 0,
        attempt: 1,
        state: "finished",
        startedAtMs: now - 8_100,
        finishedAtMs: now - 7_000,
        errorJson: null,
        metaJson: JSON.stringify({ kind: "agent", prompt: "Summarize deployment readiness" }),
        responseText: "response fallback should be suppressed by stdout event",
        cached: false,
        jjPointer: null,
        jjCwd: null,
      }),
    );
    await Effect.runPromise(
      adapter.insertAttempt({
        runId: "finished-run",
        nodeId: "done",
        iteration: 0,
        attempt: 1,
        state: "finished",
        startedAtMs: now - 18_500,
        finishedAtMs: now - 18_000,
        errorJson: null,
        metaJson: JSON.stringify({ kind: "agent", prompt: "Done?" }),
        responseText: "done",
        cached: false,
      }),
    );
    sqlite.exec(`CREATE TABLE semantic_output (
            run_id TEXT NOT NULL,
            node_id TEXT NOT NULL,
            iteration INTEGER NOT NULL,
            summary TEXT,
            payload TEXT,
            PRIMARY KEY (run_id, node_id, iteration)
        )`);
    sqlite
      .query("INSERT INTO semantic_output (run_id, node_id, iteration, summary, payload) VALUES (?, ?, ?, ?, ?)")
      .run("semantic-run", "artifact-node", 0, "ready", JSON.stringify({ checks: 3 }));
    await Effect.runPromise(
      adapter.insertOrUpdateApproval({
        runId: "semantic-run",
        nodeId: "approval-gate",
        iteration: 0,
        status: "requested",
        requestedAtMs: now - 8_000,
        decidedAtMs: null,
        note: null,
        decidedBy: null,
        requestJson: JSON.stringify({ question: "Deploy to production?" }),
        decisionJson: null,
        autoApproved: false,
      }),
    );
    await Effect.runPromise(
      adapter.insertOrUpdateApproval({
        runId: "finished-run",
        nodeId: "legacy-gate",
        iteration: 0,
        status: "requested",
        requestedAtMs: now - 19_000,
        decidedAtMs: null,
        note: null,
        decidedBy: null,
        requestJson: JSON.stringify({ question: "Old approval?" }),
        decisionJson: null,
        autoApproved: false,
      }),
    );
    await Effect.runPromise(
      adapter.insertEventWithNextSeq({
        runId: "semantic-run",
        timestampMs: now - 7_900,
        type: "ApprovalRequested",
        payloadJson: JSON.stringify({ runId: "semantic-run", nodeId: "approval-gate", iteration: 0 }),
      }),
    );
    await Effect.runPromise(
      adapter.insertEventWithNextSeq({
        runId: "semantic-run",
        timestampMs: now - 7_800,
        type: "NodeOutput",
        payloadJson: JSON.stringify({
          nodeId: "artifact-node",
          iteration: 0,
          attempt: 1,
          stream: "stdout",
          text: "assistant event",
        }),
      }),
    );
    await Effect.runPromise(
      adapter.insertEventWithNextSeq({
        runId: "semantic-run",
        timestampMs: now - 7_700,
        type: "NodeOutput",
        payloadJson: JSON.stringify({
          nodeId: "artifact-node",
          iteration: 0,
          attempt: 1,
          stream: "stderr",
          text: "stderr event",
        }),
      }),
    );
    await Effect.runPromise(
      adapter.upsertWorkspaceState({
        runId: "semantic-run",
        jjCwd: cwd,
        jjCommitId: "checkpoint-commit",
        jjOperationId: "checkpoint-op",
        createdAtMs: now - 6_000,
      }),
    );
    await Effect.runPromise(
      adapter.insertWorkspaceCheckpoint({
        runId: "semantic-run",
        nodeId: "artifact-node",
        iteration: 0,
        attempt: 1,
        seq: 0,
        jjCwd: cwd,
        jjCommitId: "checkpoint-commit",
        source: "hook",
        tier: 1,
        label: "Semantic checkpoint",
        toolUseId: null,
        createdAtMs: now - 5_500,
      }),
    );
    await captureSnapshot(adapter, "semantic-run", 1, {
      nodes: [
        {
          nodeId: "approval-gate",
          iteration: 0,
          state: "waiting-approval",
          lastAttempt: null,
          outputTable: "",
          label: "Approval Gate",
        },
        {
          nodeId: "artifact-node",
          iteration: 0,
          state: "finished",
          lastAttempt: 1,
          outputTable: "semantic_output",
          label: "Artifact Node",
        },
      ],
      outputs: {},
      ralph: [],
      input: { prompt: "seed" },
      vcsPointer: "checkpoint-commit",
      workflowHash: "workflow-hash",
    });
    await Effect.runPromise(
      adapter.insertFrame({
        runId: "semantic-run",
        frameNo: 1,
        createdAtMs: now - 5_000,
        xmlJson: '{"kind":"element","tag":"smithers:workflow","props":{},"children":[]}',
        xmlHash: "semantic-frame-1",
        mountedTaskIdsJson: '["artifact-node"]',
        taskIndexJson: "[]",
        note: null,
      }),
    );
  } finally {
    sqlite.close();
  }
}
describe("semantic MCP surface", () => {
  test("stdio mode only takes over when --mcp is requested and preserves raw CLI serving", async () => {
    let servedArgv = null;
    const cli = {
      serve: async (argv) => {
        servedArgv = argv;
      },
    };

    const skipped = await runMcpModeIfRequested(["workflow", "list"], {
      cli,
      version: "test",
    });
    expect(skipped).toBe(false);
    expect(servedArgv).toBeNull();

    const served = await runMcpModeIfRequested(
      ["--mcp", "--surface", "raw", "--allowed-tools", "list_runs", "--read-only"],
      {
        cli,
        version: "test",
      },
    );
    expect(served).toBe(true);
    expect(servedArgv).toEqual(["--mcp"]);
  });

  test("parses scoped outbound MCP options for the production --mcp entrypoint", () => {
    expect(
      parseMcpSurfaceArgv([
        "--mcp",
        "--surface",
        "both",
        "--allowed-tools",
        "list_workflows, get_run,run_workflow",
        "--read-only",
      ]),
    ).toEqual({
      surface: "both",
      argv: ["--mcp"],
      allowedTools: ["list_workflows", "get_run", "run_workflow"],
      readOnly: true,
    });
  });

  test("listTools returns the semantic tool family only", async () => {
    const server = createSemanticMcpServer({
      name: "smithers-test",
      version: "test",
    });
    servers.push(server);
    const client = new Client({
      name: "smithers-semantic-test-client",
      version: "test",
    });
    clients.push(client);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual([...SEMANTIC_TOOL_NAMES].sort());
    const restore = tools.find((tool) => tool.name === "restore_checkpoint");
    const travel = tools.find((tool) => tool.name === "time_travel");
    expect(restore.inputSchema.properties.confirm).toMatchObject({ type: "boolean", default: false });
    expect(travel.inputSchema.properties.confirm).toMatchObject({ type: "boolean", default: false });
  });

  test("can scope outbound discovery to explicitly allowed read-only semantic tools", async () => {
    const server = createSemanticMcpServer({
      name: "smithers-test",
      version: "test",
      allowedTools: ["list_workflows", "run_workflow", "get_run"],
      readOnly: true,
    });
    servers.push(server);
    const client = new Client({
      name: "smithers-semantic-test-client",
      version: "test",
    });
    clients.push(client);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(["get_run", "list_workflows"]);
  });

  test("can register raw CLI tools on the semantic MCP server", async () => {
    const rawCli = Cli.create({
      name: "smithers-test",
      description: "Smithers test CLI",
      version: "test",
      mcp: { command: "smithers-test --mcp" },
    }).command("raw-ping", {
      description: "Raw ping test command",
      options: z.object({
        loud: z.boolean().default(false),
      }),
      run(c) {
        return c.ok({ loud: c.options.loud });
      },
    });
    const server = createSemanticMcpServer({
      name: "smithers-test",
      version: "test",
    });
    registerRawToolsOnMcpServer(server, { cli: rawCli });
    servers.push(server);
    const client = new Client({
      name: "smithers-semantic-test-client",
      version: "test",
    });
    clients.push(client);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toContain("list_workflows");
    expect(names).toContain("raw-ping");
  });

  test("forwards MCP request context to semantic tool handlers", async () => {
    let seenExtra = null;
    const server = createSemanticMcpServer({
      name: "smithers-test",
      version: "test",
      allowedTools: [],
    });
    registerSemanticTools(server, [
      {
        name: "list_workflows",
        description: "Test context forwarding",
        inputSchema: z.object({}),
        outputSchema: z.object({ ok: z.boolean() }),
        annotations: { readOnlyHint: true },
        handler: async (_input, extra) => {
          seenExtra = extra;
          return {
            content: [{ type: "text", text: '{"ok":true}' }],
            structuredContent: { ok: true },
          };
        },
      },
    ]);
    servers.push(server);
    const client = new Client({
      name: "smithers-semantic-test-client",
      version: "test",
    });
    clients.push(client);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    await client.callTool({ name: "list_workflows", arguments: {} });
    expect(seenExtra).toBeTruthy();
    expect(seenExtra.signal).toBeInstanceOf(AbortSignal);
    expect(seenExtra.requestId).toBeDefined();
  });

  test("run_workflow validates the real workflow summary through Client.callTool", async () => {
    const cwd = tempCwd();
    mkdirSync(join(cwd, ".smithers", "workflows"), { recursive: true });
    writeFileSync(
      join(cwd, ".smithers", "workflows", "quick.tsx"),
      [
        "/** @jsxImportSource smthrs */",
        'import { createSmithers, Workflow, Task } from "smthrs";',
        'import { z } from "zod";',
        "const { smithers, outputs } = createSmithers({ result: z.object({ value: z.number() }) });",
        "export default smithers(() => (",
        '  <Workflow name="quick">',
        '    <Task id="answer" output={outputs.result}>',
        "      {{ value: 42 }}",
        "    </Task>",
        "  </Workflow>",
        "));",
        "",
      ].join("\n"),
    );
    const server = createSemanticMcpServer({
      name: "smithers-test",
      version: "test",
      allowedTools: [],
    });
    registerSemanticTools(
      server,
      createSemanticToolDefinitions({ cwd: () => cwd }).filter((tool) => tool.name === "run_workflow"),
    );
    servers.push(server);
    const client = new Client({
      name: "smithers-semantic-test-client",
      version: "test",
    });
    clients.push(client);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({
      name: "run_workflow",
      arguments: {
        workflowId: "quick",
        runId: "semantic-mcp-quick",
        waitForTerminal: true,
      },
    });
    expect(result.structuredContent.ok).toBe(true);
    expect(result.structuredContent.data.workflow.id).toBe("quick");
    expect(result.structuredContent.data.workflow.path).toBe(result.structuredContent.data.workflow.entryFile);
    expect(result.structuredContent.data.launchMode).toBe("waited");
    expect(result.structuredContent.data.status).toBe("finished");
  }, 30_000);

  test("spawns the real stdio semantic server with annotations and structured envelopes", async () => {
    const cwd = tempCwd();
    const home = tempCwd();
    mkdirSync(join(cwd, ".smithers", "workflows"), { recursive: true });
    writeFileSync(join(cwd, ".smithers", "workflows", "visible-flow.tsx"), "export default {};\n");
    writeFileSync(
      join(cwd, ".smithers", "workflows", "system-flow.tsx"),
      ["// smithers-system: true", "export default {};", ""].join("\n"),
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        join(import.meta.dir, "..", "src", "index.js"),
        "--mcp",
        "--surface",
        "semantic",
        "--allowed-tools",
        "list_workflows,run_workflow",
        "--read-only",
      ],
      cwd,
      env: stringEnv({
        HOME: home,
        SMITHERS_BACKEND: "sqlite",
        SMITHERS_NO_SKILL_REFRESH: "1",
        SMITHERS_NO_UPDATE_CHECK: "1",
        CI: "1",
      }),
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const client = new Client({
      name: "smithers-stdio-semantic-test-client",
      version: "test",
    });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(["list_workflows"]);
      expect(tools[0].annotations).toMatchObject({ readOnlyHint: true });
      expect(tools[0].inputSchema).toBeTruthy();
      expect(tools[0].outputSchema).toBeTruthy();

      const listed = await client.callTool({
        name: "list_workflows",
        arguments: {},
      });
      const data = expectToolOk(listed);
      expect(data.workflows.map((workflow) => workflow.id)).toContain("visible-flow");
      expect(data.workflows.map((workflow) => workflow.id)).not.toContain("system-flow");

      const withSystem = await client.callTool({
        name: "list_workflows",
        arguments: { includeSystem: true },
      });
      expectToolOk(withSystem);
      expect(withSystem.structuredContent.data.workflows.map((workflow) => workflow.id)).toContain("system-flow");
    } catch (error) {
      throw new Error(`${error?.message ?? String(error)}\nchild stderr:\n${stderr}`);
    } finally {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    }
  }, 30_000);

  test("stdio watch_run rejects oversized timeouts before polling and stays responsive", async () => {
    const cwd = tempCwd();
    const home = tempCwd();
    await seedSemanticDb(cwd);

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        join(import.meta.dir, "..", "src", "index.js"),
        "--mcp",
        "--surface",
        "semantic",
        "--allowed-tools",
        "watch_run,list_runs",
        "--read-only",
      ],
      cwd,
      env: stringEnv({
        HOME: home,
        SMITHERS_BACKEND: "sqlite",
        SMITHERS_NO_SKILL_REFRESH: "1",
        SMITHERS_NO_UPDATE_CHECK: "1",
        CI: "1",
      }),
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const client = new Client({
      name: "smithers-stdio-semantic-watch-test-client",
      version: "test",
    });
    try {
      await client.connect(transport);
      const startedAtMs = Date.now();
      const rejected = await client.callTool(
        {
          name: "watch_run",
          arguments: {
            runId: "running-run",
            timeoutMs: Number.MAX_SAFE_INTEGER,
            intervalMs: 1,
          },
        },
        undefined,
        { timeout: 2_000 },
      );
      expect(Date.now() - startedAtMs).toBeLessThan(1_500);
      const error = expectToolError(rejected, "INVALID_INPUT");
      expect(error.message).toContain("timeoutMs");
      expect(error.details).toMatchObject({
        timeoutMs: Number.MAX_SAFE_INTEGER,
        maxTimeoutMs: 3_600_000,
      });

      const listed = expectToolOk(
        await client.callTool(
          {
            name: "list_runs",
            arguments: { limit: 1 },
          },
          undefined,
          { timeout: 2_000 },
        ),
      );
      expect(listed.runs).toHaveLength(1);
    } catch (error) {
      throw new Error(`${error?.message ?? String(error)}\nchild stderr:\n${stderr}`);
    } finally {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    }
  }, 30_000);

  test("serves real sqlite run inspection, approval, artifact, chat, and event tools through MCP", async () => {
    const cwd = tempCwd();
    await seedSemanticDb(cwd);
    await withSqliteBackend(async () => {
      const client = await connectSelectedSemanticTools(cwd, [
        "list_runs",
        "get_run",
        "watch_run",
        "explain_run",
        "list_pending_approvals",
        "resolve_approval",
        "get_node_detail",
        "list_artifacts",
        "get_chat_transcript",
        "get_run_events",
      ]);

      const runs = expectToolOk(
        await client.callTool({
          name: "list_runs",
          arguments: { limit: 1, status: "waiting-approval" },
        }),
      );
      expect(runs.runs).toHaveLength(1);
      expect(runs.runs[0]).toMatchObject({
        runId: "semantic-run",
        workflowName: "deploy-flow",
        pendingApprovalCount: 1,
      });

      const run = expectToolOk(
        await client.callTool({
          name: "get_run",
          arguments: { runId: "semantic-run" },
        }),
      );
      expect(run.run.steps.map((step) => step.nodeId).sort()).toEqual(["approval-gate", "artifact-node"]);
      expect(run.run.approvals[0].request).toEqual({ question: "Deploy to production?" });

      const watched = expectToolOk(
        await client.callTool({
          name: "watch_run",
          arguments: { runId: "semantic-run", intervalMs: 1, timeoutMs: 0 },
        }),
      );
      expect(watched.timedOut).toBe(true);
      expect(watched.reachedTerminal).toBe(false);
      expect(watched.intervalMs).toBe(500);

      const terminal = expectToolOk(
        await client.callTool({
          name: "watch_run",
          arguments: { runId: "finished-run", intervalMs: 1, timeoutMs: 0 },
        }),
      );
      expect(terminal.reachedTerminal).toBe(true);

      const explanation = expectToolOk(
        await client.callTool({
          name: "explain_run",
          arguments: { runId: "semantic-run" },
        }),
      );
      expect(explanation.diagnosis).toMatchObject({
        runId: "semantic-run",
        status: "waiting-approval",
      });

      const pending = expectToolOk(
        await client.callTool({
          name: "list_pending_approvals",
          arguments: { workflowName: "deploy-flow" },
        }),
      );
      expect(pending.approvals.map((approval) => approval.nodeId).sort()).toEqual(["approval-gate"]);

      const approved = expectToolOk(
        await client.callTool({
          name: "resolve_approval",
          arguments: {
            action: "approve",
            runId: "semantic-run",
            nodeId: "approval-gate",
            iteration: 0,
            note: "ship",
            decidedBy: "mcp-test",
            decision: { selected: "yes" },
          },
        }),
      );
      expect(approved.approval).toMatchObject({
        status: "approved",
        note: "ship",
        decidedBy: "mcp-test",
        decision: { selected: "yes" },
      });

      const remaining = expectToolOk(
        await client.callTool({
          name: "list_pending_approvals",
          arguments: { workflowName: "deploy-flow" },
        }),
      );
      expect(remaining.approvals.map((approval) => approval.nodeId)).toEqual([]);

      const nodeDetail = expectToolOk(
        await client.callTool({
          name: "get_node_detail",
          arguments: { runId: "semantic-run", nodeId: "artifact-node" },
        }),
      );
      expect(nodeDetail.detail.output).toMatchObject({
        source: "output-table",
        validated: {
          summary: "ready",
          payload: { checks: 3 },
        },
      });

      const artifacts = expectToolOk(
        await client.callTool({
          name: "list_artifacts",
          arguments: { runId: "semantic-run", includeRaw: true },
        }),
      );
      expect(artifacts.artifacts).toHaveLength(1);
      expect(artifacts.artifacts[0]).toMatchObject({
        artifactId: "semantic-run:artifact-node:0",
        source: "output-table",
        value: {
          summary: "ready",
          payload: { checks: 3 },
        },
        rawValue: {
          summary: "ready",
          payload: { checks: 3 },
        },
      });

      const chat = expectToolOk(
        await client.callTool({
          name: "get_chat_transcript",
          arguments: {
            runId: "semantic-run",
            all: true,
            includeStderr: false,
            tail: 2,
          },
        }),
      );
      expect(chat.messages.map((message) => message.source)).toEqual(["prompt", "event"]);
      expect(chat.messages.map((message) => message.role)).toEqual(["user", "assistant"]);

      const events = expectToolOk(
        await client.callTool({
          name: "get_run_events",
          arguments: {
            runId: "semantic-run",
            types: ["ApprovalRequested"],
            limit: 1,
          },
        }),
      );
      expect(events.events).toHaveLength(1);
      expect(events.events[0].payload).toMatchObject({
        runId: "semantic-run",
        nodeId: "approval-gate",
        request: { question: "Deploy to production?" },
      });
    });
  }, 30_000);

  test("serves real sqlite semantic time-travel wrappers and destructive guards through MCP", async () => {
    const cwd = tempCwd();
    await seedSemanticDb(cwd);
    await withSqliteBackend(async () => {
      const client = await connectSelectedSemanticTools(cwd, [
        "revert_attempt",
        "fork_run",
        "replay_run",
        "rewind_run",
        "restore_checkpoint",
        "list_snapshots",
        "get_timeline",
        "get_run",
        "time_travel",
      ]);

      const snapshots = expectToolOk(
        await client.callTool({
          name: "list_snapshots",
          arguments: { runId: "semantic-run" },
        }),
      );
      expect(snapshots.snapshots).toEqual([
        {
          runId: "semantic-run",
          seq: 0,
          nodeId: "artifact-node",
          iteration: 0,
          attempt: 1,
          tier: 1,
          source: "hook",
          label: "Semantic checkpoint",
          commitId: "checkpoint-commit",
          operationId: "checkpoint-op",
          cwd,
          createdAtMs: Date.UTC(2026, 0, 2, 3, 4, 5) - 5_500,
        },
      ]);

      const restore = expectToolOk(
        await client.callTool({
          name: "restore_checkpoint",
          arguments: {
            runId: "semantic-run",
            nodeId: "artifact-node",
            seq: 0,
            confirm: true,
          },
        }),
      );
      expect(restore).toMatchObject({
        runId: "semantic-run",
        nodeId: "artifact-node",
        seq: 0,
        commitId: "checkpoint-commit",
        cwd,
        success: false,
      });
      expect(restore.error).toBeString();

      const revert = expectToolOk(
        await client.callTool({
          name: "revert_attempt",
          arguments: {
            runId: "semantic-run",
            nodeId: "artifact-node",
            iteration: 0,
            attempt: 1,
          },
        }),
      );
      expect(revert).toMatchObject({
        runId: "semantic-run",
        nodeId: "artifact-node",
        attempt: 1,
        success: false,
        effectBoundary: { blocking: [], revertible: [], warnings: [] },
      });
      expect(revert.error).toContain("jjPointer");

      const timeline = expectToolOk(
        await client.callTool({
          name: "get_timeline",
          arguments: { runId: "semantic-run" },
        }),
      );
      expect(timeline.timeline).toMatchObject({ runId: "semantic-run" });
      expect(timeline.timeline.frames.map((frame) => frame.frameNo)).toEqual([1]);

      const fork = expectToolOk(
        await client.callTool({
          name: "fork_run",
          arguments: {
            parentRunId: "semantic-run",
            frameNo: 1,
            resetNodes: ["artifact-node"],
            inputOverrides: { prompt: "forked" },
            branchLabel: "mcp fork",
          },
        }),
      );
      expect(fork.parentRunId).toBe("semantic-run");
      expect(fork.parentFrameNo).toBe(1);
      expect(fork.effectBoundary).toEqual({ blocking: [], revertible: [], warnings: [] });
      expect(fork.branch.branchLabel).toBe("mcp fork");
      expect(JSON.parse(fork.snapshot.inputJson)).toEqual({ prompt: "forked" });
      expect(JSON.parse(fork.snapshot.nodesJson).find((node) => node.nodeId === "artifact-node")).toMatchObject({
        state: "pending",
        lastAttempt: null,
      });

      const replay = expectToolOk(
        await client.callTool({
          name: "replay_run",
          arguments: {
            parentRunId: "semantic-run",
            frameNo: 1,
            restoreVcs: false,
            branchLabel: "mcp replay",
          },
        }),
      );
      expect(replay.parentRunId).toBe("semantic-run");
      expect(replay.parentFrameNo).toBe(1);
      expect(replay.vcsRestored).toBe(false);
      expect(replay.vcsPointer).toBeNull();
      expect(replay.effectBoundary).toEqual({ blocking: [], revertible: [], warnings: [] });

      const tree = expectToolOk(
        await client.callTool({
          name: "get_timeline",
          arguments: { runId: "semantic-run", tree: true },
        }),
      );
      expect(tree.timeline.children.length).toBeGreaterThanOrEqual(2);

      const rewind = await client.callTool({
        name: "rewind_run",
        arguments: {
          runId: "semantic-run",
          frameNo: 0,
        },
      });
      expectToolError(rewind, "INVALID_INPUT");
      const cleanRewindResult = await client.callTool({
        name: "rewind_run",
        arguments: {
          runId: "semantic-run",
          frameNo: 1,
          confirm: true,
        },
      });
      const cleanRewind = expectToolOk(cleanRewindResult);
      expect(cleanRewind.effectBoundary).toEqual({ blocking: [], revertible: [], warnings: [] });

      const blocked = await client.callTool({
        name: "time_travel",
        arguments: {
          runId: "running-run",
          nodeId: "artifact-node",
        },
      });
      const error = expectToolError(blocked, "INVALID_INPUT");
      expect(error.message).toContain("confirm=true");

      const forceBlocked = await client.callTool({
        name: "time_travel",
        arguments: {
          runId: "running-run",
          nodeId: "artifact-node",
          confirm: true,
        },
      });
      const runningError = expectToolError(forceBlocked, "RUN_STILL_RUNNING");
      expect(runningError.message).toContain("Pass force=true");

      const finishedBefore = expectToolOk(
        await client.callTool({
          name: "get_run",
          arguments: { runId: "finished-run" },
        }),
      );
      const finishedBlocked = await client.callTool({
        name: "time_travel",
        arguments: {
          runId: "finished-run",
          nodeId: "done",
        },
      });
      const finishedError = expectToolError(finishedBlocked, "INVALID_INPUT");
      expect(finishedError.message).toContain("confirm=true");
      expect(
        expectToolOk(
          await client.callTool({
            name: "get_run",
            arguments: { runId: "finished-run" },
          }),
        ),
      ).toEqual(finishedBefore);

      const failedBefore = expectToolOk(
        await client.callTool({
          name: "get_run",
          arguments: { runId: "failed-run" },
        }),
      );
      const failedBlocked = await client.callTool({
        name: "time_travel",
        arguments: {
          runId: "failed-run",
          nodeId: "done",
        },
      });
      const failedError = expectToolError(failedBlocked, "INVALID_INPUT");
      expect(failedError.message).toContain("confirm=true");
      expect(
        expectToolOk(
          await client.callTool({
            name: "get_run",
            arguments: { runId: "failed-run" },
          }),
        ),
      ).toEqual(failedBefore);

      const travelled = expectToolOk(
        await client.callTool({
          name: "time_travel",
          arguments: {
            runId: "finished-run",
            nodeId: "done",
            confirm: true,
            restoreVcs: false,
          },
        }),
      );
      expect(travelled.run.runId).toBe("finished-run");
      expect(travelled.effectBoundary).toEqual({ blocking: [], revertible: [], warnings: [] });
    });
  }, 30_000);

  test("rejects invalid semantic tool discovery definitions before serving", () => {
    const baseTool = {
      name: "list_workflows",
      description: "List workflows",
      inputSchema: {},
      outputSchema: {},
      annotations: { readOnlyHint: true },
      handler: async () => ({
        content: [],
        structuredContent: { ok: true, data: {} },
      }),
    };
    const server = createSemanticMcpServer({
      name: "smithers-test",
      version: "test",
      allowedTools: [],
    });

    expect(() => registerSemanticTools(server, [baseTool, { ...baseTool }])).toThrow(/Duplicate semantic MCP tool/);
    expect(() => registerSemanticTools(server, [{ ...baseTool, name: "shell" }])).toThrow(/Unknown semantic MCP tool/);
  });
});
