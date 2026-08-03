/** @jsxImportSource smthrs */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { createSmithers } from "smthrs";
import { Gateway } from "../src/gateway.js";
import { sleep } from "../../smithers/tests/helpers.js";

function getPort(server) {
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Gateway server did not expose a port");
  }
  return addr.port;
}

async function waitFor(assertion, { timeoutMs = 5000, intervalMs = 25 } = {}) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      return await assertion();
    } catch (error) {
      lastError = error;
      await sleep(intervalMs);
    }
  }
  throw lastError;
}

function busyBlock(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {}
}

function createCountingWorkflow(dbPath, name, counter, { blockMs = 0, throws = false } = {}) {
  const { smithers, Workflow, Task, outputs } = createSmithers({ result: z.object({ ok: z.boolean() }) }, { dbPath });
  return smithers(() => {
    counter.count += 1;
    if (blockMs > 0) {
      busyBlock(blockMs);
    }
    if (throws) {
      throw new TypeError("rows.length undefined");
    }
    return (
      <Workflow name={name}>
        <Task id="task1" output={outputs.result}>
          {{ ok: true }}
        </Task>
      </Workflow>
    );
  });
}

function createInlineUiWorkflow(dbPath, name, counter) {
  const { smithers, Workflow, Task, UI, outputs } = createSmithers(
    { result: z.object({ ok: z.boolean() }) },
    { dbPath },
  );
  return smithers(() => {
    counter.count += 1;
    return (
      <Workflow name={name}>
        <UI title={`${name} UI`} props={{ source: "view-discovery-test" }}>
          <main data-testid={`${name}-ui`}>
            <h1>{`${name} UI`}</h1>
          </main>
        </UI>
        <Task id="task1" output={outputs.result}>
          {{ ok: true }}
        </Task>
      </Workflow>
    );
  });
}

function captureGatewayLogs() {
  const messages = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  const record = (args) => {
    const line = args.map((value) => (typeof value === "string" ? value : "")).join(" ");
    if (line) {
      messages.push(line);
    }
  };
  console.log = (...args) => record(args);
  console.error = (...args) => record(args);
  console.warn = (...args) => record(args);
  return {
    count(substring) {
      return messages.filter((line) => line.includes(substring)).length;
    },
    restore() {
      console.log = originalLog;
      console.error = originalError;
      console.warn = originalWarn;
    },
  };
}

describe("Gateway workflow view discovery", () => {
  let gateway;
  let tempDir;
  let logs;

  afterEach(async () => {
    logs?.restore();
    logs = undefined;
    if (gateway) {
      await gateway.close();
      gateway = undefined;
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  function makeDbPath(name) {
    tempDir = tempDir ?? mkdtempSync(join(tmpdir(), "smithers-view-discovery-"));
    return join(tempDir, `${name}.db`);
  }

  test("register never renders synchronously and /health answers while slow renders drain", async () => {
    // Incident regression: rendering every pack workflow inside register()
    // pegged the event loop at ~99% CPU and /health went unreachable.
    const counter = { count: 0 };
    gateway = new Gateway();
    const total = 8;
    for (let index = 0; index < total; index += 1) {
      gateway.register(
        `slow-${index}`,
        createCountingWorkflow(makeDbPath(`slow-${index}`), `slow-${index}`, counter, { blockMs: 20 }),
      );
    }
    // Registration itself must not render: 8 x 20ms of blocking render work
    // would otherwise have run synchronously by this line.
    expect(counter.count).toBe(0);

    const server = await gateway.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = `http://127.0.0.1:${getPort(server)}`;
    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
    expect((await health.json()).ok).toBe(true);
    // /health was served before the whole pack rendered: discovery drains one
    // render per macrotask, so the event loop always gets a slice.
    expect(counter.count).toBeLessThan(total);

    await gateway.awaitAllWorkflowViewDiscovery();
    expect(counter.count).toBe(total);
  }, 20_000);

  test("a throwing discovery render is skipped with one warn and never retried", async () => {
    logs = captureGatewayLogs();
    const counter = { count: 0 };
    gateway = new Gateway();
    gateway.register(
      "crash-recovery",
      createCountingWorkflow(makeDbPath("crash-recovery"), "crash-recovery", counter, { throws: true }),
    );
    const server = await gateway.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = `http://127.0.0.1:${getPort(server)}`;

    await gateway.awaitAllWorkflowViewDiscovery();
    // Repeated requests — health, aggregate list, the workflow's own UI route —
    // must never re-render the throwing workflow (the hot-loop regression).
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
      expect((await fetch(`${baseUrl}/workflows`)).status).toBe(200);
      await fetch(`${baseUrl}/workflows/crash-recovery`);
    }
    await sleep(50);
    expect(counter.count).toBe(1);
    expect(logs.count("workflow UI discovery render failed")).toBe(1);
    const list = await (await fetch(`${baseUrl}/workflows`)).json();
    expect(list.workflows.find((workflow) => workflow.key === "crash-recovery")?.hasUi).toBe(false);
  }, 20_000);

  test("a workflow UI request renders its view on demand, exactly once", async () => {
    const counter = { count: 0 };
    gateway = new Gateway();
    gateway.register("inline", createInlineUiWorkflow(makeDbPath("inline"), "inline", counter));
    expect(counter.count).toBe(0);
    const server = await gateway.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = `http://127.0.0.1:${getPort(server)}`;

    const first = await fetch(`${baseUrl}/workflows/inline`);
    expect(first.status).toBe(200);
    expect(await first.text()).toContain("<title>inline UI</title>");
    expect(counter.count).toBe(1);

    // Cached: subsequent UI requests and aggregate lists never re-render.
    const second = await fetch(`${baseUrl}/workflows/inline`);
    expect(second.status).toBe(200);
    const bundle = await fetch(`${baseUrl}/workflows/inline/__smithers_ui/client.js`);
    expect(bundle.status).toBe(200);
    expect(await bundle.text()).toContain("inline UI");
    const list = await (await fetch(`${baseUrl}/workflows`)).json();
    expect(list.workflows.find((workflow) => workflow.key === "inline")).toMatchObject({
      hasUi: true,
      uiPath: "/workflows/inline",
    });
    expect(counter.count).toBe(1);
  }, 20_000);

  test("aggregate workflow lists drain pending discovery before answering", async () => {
    const counter = { count: 0 };
    gateway = new Gateway();
    gateway.register("listed", createInlineUiWorkflow(makeDbPath("listed"), "listed", counter));
    const server = await gateway.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = `http://127.0.0.1:${getPort(server)}`;

    const list = await (await fetch(`${baseUrl}/workflows`)).json();
    expect(list.workflows.find((workflow) => workflow.key === "listed")).toMatchObject({ hasUi: true });
    expect(counter.count).toBe(1);
  }, 20_000);

  test("a render over the time budget warns once", async () => {
    logs = captureGatewayLogs();
    const counter = { count: 0 };
    gateway = new Gateway();
    gateway.viewDiscoverySlowMs = 1;
    gateway.register("sluggish", createCountingWorkflow(makeDbPath("sluggish"), "sluggish", counter, { blockMs: 20 }));
    await gateway.awaitAllWorkflowViewDiscovery();
    await sleep(50);
    expect(counter.count).toBe(1);
    expect(logs.count("workflow UI discovery render exceeded time budget")).toBe(1);
  }, 20_000);

  test("close settles queued discovery without rendering", async () => {
    const counter = { count: 0 };
    gateway = new Gateway();
    gateway.register("pending", createCountingWorkflow(makeDbPath("pending"), "pending", counter));
    const drained = gateway.awaitAllWorkflowViewDiscovery();
    await gateway.close();
    gateway = undefined;
    await drained;
    // The queued render may or may not have run before close raced it, but it
    // must never hang and never render more than once.
    expect(counter.count).toBeLessThanOrEqual(1);
  }, 20_000);
});
