/** @jsxImportSource smithers-orchestrator */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { z } from "zod";
import { createSmithers } from "smithers-orchestrator";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { Gateway } from "@smithers-orchestrator/server/gateway";
import { SmithersGatewayClient } from "smithers-orchestrator/gateway-client";
import { createGatewayObservationSource } from "../src/supervisor-observation.js";

/**
 * End-to-end regression guard for the S2 streamed-activity path against a REAL
 * gateway over a REAL WebSocket, with the REAL SmithersGatewayClient feeding the
 * production `createGatewayObservationSource`.
 *
 * Fix-round-3 background: the streamed-activity unit tests hand-fabricated
 * `run.event` frames carrying PascalCase `payload.event` names ("ToolCallStarted"
 * …) the live gateway NEVER produces. The gateway actually maps every run-event
 * to a dotted name — per-node tool activity arrives as `agent.event` — so the
 * consumer's PascalCase pre-filter dropped every real frame and the strip showed
 * nothing. This test drives a genuine AgentEvent through the server's own
 * `mapEvent`/broadcast pipeline and asserts the supervisor renders the tool line,
 * so a name/shape divergence between server and consumer can't regress silently.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 5000, stepMs = 25) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await sleep(stepMs);
  }
  return false;
}

function getPort(server) {
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  return addr.port;
}

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch {
      /* best effort */
    }
  }
});

async function bootSeededGateway(runId) {
  const dbPath = join(tmpdir(), `supervisor-stream-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const { smithers, Workflow, Task, outputs } = createSmithers({ result: z.object({ value: z.number() }) }, { dbPath });
  const workflow = smithers(() => (
    <Workflow name="deploy">
      <Task id="build" output={outputs.result}>
        {{ value: 1 }}
      </Task>
    </Workflow>
  ));
  const gateway = new Gateway({});
  gateway.register("deploy", workflow);
  // A seeded "running" run makes streamRunEvents resolvable (RunNotFound otherwise).
  ensureSmithersTables(workflow.db);
  await new SmithersDb(workflow.db).insertRun({
    runId,
    workflowName: "deploy",
    status: "running",
    createdAtMs: Date.now(),
  });

  const server = await gateway.listen({ port: 0, host: "127.0.0.1" });
  cleanups.push(() => gateway.close());
  cleanups.push(() => {
    for (const suffix of ["", "-shm", "-wal"]) {
      try {
        rmSync(`${dbPath}${suffix}`, { force: true });
      } catch {
        /* ignore */
      }
    }
  });
  const baseUrl = `http://127.0.0.1:${getPort(server)}`;
  const client = new SmithersGatewayClient({
    baseUrl,
    WebSocket,
    client: { id: "supervisor-stream-e2e", version: "0.0.0", platform: "bun-test" },
  });
  return { gateway, client };
}

/** A real AgentEvent CLI-agent tool action, exactly as the runtime emits it. */
function toolActionEvent(runId, nodeId, phase, detail, { id = "call-1", title = "bash" } = {}) {
  return {
    type: "AgentEvent",
    runId,
    nodeId,
    iteration: 0,
    attempt: 1,
    engine: "claude-code",
    event: { type: "action", engine: "claude-code", phase, action: { kind: "tool", id, title, detail } },
  };
}

describe("supervisor gateway streamed activity (real gateway over WS)", () => {
  test("renders a streamed AgentEvent tool line via the live mapEvent + WS path", async () => {
    const runId = "run-stream-e2e";
    const nodeId = "build";
    const { gateway, client } = await bootSeededGateway(runId);
    const source = createGatewayObservationSource(client);
    cleanups.push(() => source.dispose?.());

    // Warm the background subscription, then wait for the WS to actually connect
    // so the injected events broadcast to a live subscriber.
    await source.nodeActivity(runId, nodeId, { limit: 4 });
    expect(await waitFor(() => (gateway.connections?.size ?? 0) >= 1, 5000)).toBe(true);
    await sleep(200); // let the streamRunEvents subscribe RPC register the stream

    // Inject a real tool action pair through the gateway's live event pipeline:
    // handleSmithersEvent -> mapEvent("agent.event") -> broadcastEvent -> WS frame.
    gateway.handleSmithersEvent(toolActionEvent(runId, nodeId, "started", { input: { command: "ls -la" } }));
    gateway.handleSmithersEvent(toolActionEvent(runId, nodeId, "completed", { output: "total 0" }));

    // The server-mapped frame name is the dotted "agent.event", NOT PascalCase.
    const frame = gateway.runEventWindows?.get(runId)?.window?.[0];
    expect(frame?.event).toBe("agent.event");

    let lines = [];
    const rendered = await waitFor(async () => {
      lines = await source.nodeActivity(runId, nodeId, { limit: 4 });
      return lines.length > 0;
    }, 5000);
    expect(rendered).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0].title).toBe("bash");
    expect(lines[0].kind).toBe("tool");
    // started + completed share id "call-1" → the pair collapses to one done line.
    expect(lines[0].status).toBe("done");
  });

  test("filters streamed activity to the focused node", async () => {
    const runId = "run-stream-e2e-filter";
    const { gateway, client } = await bootSeededGateway(runId);
    const source = createGatewayObservationSource(client);
    cleanups.push(() => source.dispose?.());

    await source.nodeActivity(runId, "build", { limit: 4 });
    expect(await waitFor(() => (gateway.connections?.size ?? 0) >= 1, 5000)).toBe(true);
    await sleep(200);

    gateway.handleSmithersEvent(
      toolActionEvent(runId, "build", "started", { input: { command: "make" } }, { id: "call-1", title: "make" }),
    );
    gateway.handleSmithersEvent(
      toolActionEvent(runId, "deploy", "started", { input: {} }, { id: "call-9", title: "scp" }),
    );

    // build's strip surfaces its own tool and NOT deploy's, from the shared ring.
    let buildLines = [];
    expect(
      await waitFor(async () => {
        buildLines = await source.nodeActivity(runId, "build", { limit: 4 });
        return buildLines.length > 0;
      }, 5000),
    ).toBe(true);
    expect(buildLines.some((l) => l.title === "make")).toBe(true);
    expect(buildLines.some((l) => l.title === "scp")).toBe(false);

    const deployLines = await source.nodeActivity(runId, "deploy", { limit: 4 });
    expect(deployLines.some((l) => l.title === "scp")).toBe(true);
  });
});
