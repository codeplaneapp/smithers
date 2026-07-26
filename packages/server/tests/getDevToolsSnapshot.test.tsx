/** @jsxImportSource smthrs */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";
import { z } from "zod";
import { Effect } from "effect";
import { createSmithers, runWorkflow } from "smthrs";
import { canonicalizeXml } from "@smthrs/graph/utils/xml";
import { SmithersDb } from "@smthrs/db/adapter";
import { ensureSmithersTables } from "@smthrs/db/ensure";
import type { DevToolsSnapshot } from "@smthrs/protocol";
import { Gateway } from "../src/gateway.js";
import { DEVTOOLS_TASK_PROMPT_MAX_CHARS, getDevToolsSnapshotRoute } from "../src/gatewayRoutes/getDevToolsSnapshot.js";
import { sleep } from "../../smithers/tests/helpers.js";

function createAdapter() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { adapter: new SmithersDb(db), sqlite };
}

function xmlFrame(name = "workflow", value = "ok"): string {
  return canonicalizeXml({
    kind: "element",
    tag: "smithers:workflow",
    props: { name },
    children: [
      {
        kind: "element",
        tag: "smithers:task",
        props: { id: "task-a::0", value },
        children: [],
      },
    ],
  });
}

function deepXml(depth: number): string {
  let cursor: any = {
    kind: "element",
    tag: "smithers:task",
    props: { id: "leaf::0" },
    children: [],
  };
  for (let index = depth - 1; index >= 0; index -= 1) {
    cursor = {
      kind: "element",
      tag: "smithers:task",
      props: { id: `node-${index}::0` },
      children: [cursor],
    };
  }
  return canonicalizeXml({
    kind: "element",
    tag: "smithers:workflow",
    props: { name: "deep" },
    children: [cursor],
  });
}

function now() {
  return Date.now();
}

class GatewayClient {
  ws: WebSocket;
  messages: any[] = [];

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (raw) => {
      this.messages.push(JSON.parse(String(raw)));
    });
  }

  async waitFor(predicate: (message: any) => boolean, timeoutMs = 5_000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const index = this.messages.findIndex(predicate);
      if (index >= 0) {
        return this.messages.splice(index, 1)[0];
      }
      await sleep(10);
    }
    throw new Error("timed out waiting for gateway message");
  }

  async request(method: string, params?: unknown) {
    const id = `${method}-${Math.random().toString(36).slice(2)}`;
    this.ws.send(JSON.stringify({ type: "req", id, method, params }));
    return this.waitFor((message) => message.type === "res" && message.id === id);
  }

  async close() {
    if (this.ws.readyState === this.ws.CLOSED) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.ws.once("close", () => resolve());
      this.ws.close();
    });
  }
}

async function connectGateway(port: number, token: string, subscribe?: string[]) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });
      const client = new GatewayClient(ws);
      await client.waitFor((message) => message.type === "event" && message.event === "connect.challenge");
      const hello = await client.request("connect", {
        minProtocol: 1,
        maxProtocol: 1,
        client: { id: "devtools-test", version: "1.0.0", platform: "bun-test" },
        auth: { token },
        ...(subscribe ? { subscribe } : {}),
      });
      expect(hello.ok).toBe(true);
      return client;
    } catch (error) {
      if (attempt === 4) {
        throw error;
      }
      await sleep(50);
    }
  }
  throw new Error("unreachable");
}

describe("getDevToolsSnapshotRoute", () => {
  test("returns requested snapshot and defaults to latest frame", async () => {
    const { adapter, sqlite } = createAdapter();
    const runId = "run-devtools";
    await adapter.insertRun({
      runId,
      workflowName: "wf",
      status: "running",
      createdAtMs: now(),
    });
    await adapter.insertFrame({
      runId,
      frameNo: 0,
      createdAtMs: now(),
      xmlJson: xmlFrame("first", "one"),
      xmlHash: "hash-0",
      mountedTaskIdsJson: "[]",
      taskIndexJson: "[]",
      note: "frame-0",
    });
    await adapter.insertFrame({
      runId,
      frameNo: 1,
      createdAtMs: now(),
      xmlJson: xmlFrame("second", "two"),
      xmlHash: "hash-1",
      mountedTaskIdsJson: "[]",
      taskIndexJson: "[]",
      note: "frame-1",
    });
    const first: DevToolsSnapshot = await getDevToolsSnapshotRoute({
      adapter,
      runId,
      frameNo: 0,
    });
    expect(first.frameNo).toBe(0);
    expect(first.root.name).toBe("first");
    expect(first.runState?.runId).toBe(runId);
    const latest: DevToolsSnapshot = await getDevToolsSnapshotRoute({
      adapter,
      runId,
    });
    expect(latest.frameNo).toBe(1);
    expect(latest.root.name).toBe("second");
    expect(latest.runState?.runId).toBe(runId);
    sqlite.close();
  });

  test("attaches per-node lifecycle state from node rows, latest iteration wins", async () => {
    const { adapter, sqlite } = createAdapter();
    const runId = "run-node-states";
    await adapter.insertRun({
      runId,
      workflowName: "wf",
      status: "running",
      createdAtMs: now(),
    });
    await adapter.insertFrame({
      runId,
      frameNo: 0,
      createdAtMs: now(),
      xmlJson: canonicalizeXml({
        kind: "element",
        tag: "smithers:workflow",
        props: { name: "states" },
        children: [
          { kind: "element", tag: "smithers:task", props: { id: "done-task::0" }, children: [] },
          { kind: "element", tag: "smithers:task", props: { id: "busy-task::0" }, children: [] },
          { kind: "element", tag: "smithers:task", props: { id: "future-task::0" }, children: [] },
        ],
      }),
      xmlHash: "hash-states",
      mountedTaskIdsJson: "[]",
      taskIndexJson: "[]",
      note: "states",
    });
    await adapter.insertNode({
      runId,
      nodeId: "done-task",
      iteration: 0,
      state: "finished",
      lastAttempt: 1,
      updatedAtMs: now(),
      outputTable: "",
      label: null,
    });
    // Loop-style node: iteration 0 finished, iteration 1 in flight — the
    // snapshot must surface the LATEST iteration's state.
    await adapter.insertNode({
      runId,
      nodeId: "busy-task",
      iteration: 0,
      state: "finished",
      lastAttempt: 1,
      updatedAtMs: now(),
      outputTable: "",
      label: null,
    });
    await adapter.insertNode({
      runId,
      nodeId: "busy-task",
      iteration: 1,
      state: "in-progress",
      lastAttempt: 2,
      updatedAtMs: now(),
      outputTable: "",
      label: null,
    });

    const snapshot = await getDevToolsSnapshotRoute({ adapter, runId });
    const byNodeId = new Map(snapshot.root.children.map((child) => [child.task?.nodeId, child.task]));
    expect(byNodeId.get("done-task")).toMatchObject({ state: "finished", attempt: 1 });
    expect(byNodeId.get("busy-task")).toMatchObject({ state: "in-progress", attempt: 2 });
    // A frame-mounted task with no node row yet carries no state at all.
    expect(byNodeId.get("future-task")?.state).toBeUndefined();
    sqlite.close();
  });

  test("attaches declared agent summary and attempt budget from the task index", async () => {
    const { adapter, sqlite } = createAdapter();
    const runId = "run-agent-index";
    await adapter.insertRun({
      runId,
      workflowName: "wf",
      status: "running",
      createdAtMs: now(),
    });
    await adapter.insertFrame({
      runId,
      frameNo: 0,
      createdAtMs: now(),
      xmlJson: canonicalizeXml({
        kind: "element",
        tag: "smithers:workflow",
        props: { name: "agent-index" },
        children: [
          { kind: "element", tag: "smithers:task", props: { id: "review::0" }, children: [] },
          { kind: "element", tag: "smithers:task", props: { id: "plain::0" }, children: [] },
        ],
      }),
      xmlHash: "hash-agent-index",
      mountedTaskIdsJson: "[]",
      taskIndexJson: JSON.stringify([
        {
          nodeId: "review",
          ordinal: 0,
          iteration: 0,
          kind: "agent",
          agent: {
            label: "Reviewer",
            engine: "claude-code",
            model: "claude-fable-5",
            chain: [
              { engine: "claude-code", model: "claude-fable-5" },
              { engine: "codex", model: "gpt-5.4-codex" },
              // Hostile/garbage entries in stored JSON must be dropped, not
              // forwarded to clients.
              { generate: "() => {}", apiKey: "sk-nope" },
            ],
            // Non-whitelisted fields never survive into the snapshot.
            apiKey: "sk-secret",
          },
          maxAttempts: 3,
        },
        { nodeId: "plain", ordinal: 1, iteration: 0, kind: "compute" },
      ]),
      note: "agent-index",
    });

    // No node rows at all: the run is queued — the declared assignment must
    // still surface (that is the whole point of render-time capture).
    const snapshot = await getDevToolsSnapshotRoute({ adapter, runId, frameNo: 0 });
    const review = snapshot.root.children[0]?.task;
    expect(review?.state).toBeUndefined();
    expect(review?.agentSummary).toEqual({
      label: "Reviewer",
      engine: "claude-code",
      model: "claude-fable-5",
      chain: [
        { engine: "claude-code", model: "claude-fable-5" },
        { engine: "codex", model: "gpt-5.4-codex" },
      ],
    });
    expect(review?.maxAttempts).toBe(3);
    expect(JSON.stringify(review)).not.toContain("sk-secret");
    expect(JSON.stringify(review)).not.toContain("sk-nope");
    const plain = snapshot.root.children[1]?.task;
    expect(plain?.agentSummary).toBeUndefined();
    expect(plain?.maxAttempts).toBeUndefined();
    sqlite.close();
  });

  test("attaches the acting agent from the latest attempt's metadata", async () => {
    const { adapter, sqlite } = createAdapter();
    const runId = "run-agent-attempts";
    await adapter.insertRun({
      runId,
      workflowName: "wf",
      status: "running",
      createdAtMs: now(),
    });
    await adapter.insertFrame({
      runId,
      frameNo: 0,
      createdAtMs: now() + 1_000,
      xmlJson: canonicalizeXml({
        kind: "element",
        tag: "smithers:workflow",
        props: { name: "agent-attempts" },
        children: [
          { kind: "element", tag: "smithers:task", props: { id: "exec::0" }, children: [] },
          { kind: "element", tag: "smithers:task", props: { id: "queued::0" }, children: [] },
        ],
      }),
      xmlHash: "hash-agent-attempts",
      mountedTaskIdsJson: "[]",
      taskIndexJson: "[]",
      note: "agent-attempts",
    });
    await adapter.insertNode({
      runId,
      nodeId: "exec",
      iteration: 0,
      state: "in-progress",
      lastAttempt: 2,
      updatedAtMs: now(),
      outputTable: "",
      label: null,
    });
    const attemptRow = (attempt: number, metaJson: string | null) => ({
      runId,
      nodeId: "exec",
      iteration: 0,
      attempt,
      state: attempt === 2 ? "in-progress" : "failed",
      startedAtMs: now(),
      finishedAtMs: null,
      heartbeatAtMs: null,
      heartbeatDataJson: null,
      errorJson: null,
      jjPointer: null,
      jjCwd: "/tmp",
      cached: false,
      metaJson,
    });
    // Attempt 1 failed over from codex; attempt 2 (the LATEST) ran claude.
    await adapter.insertAttempt(
      attemptRow(1, JSON.stringify({ agentEngine: "codex", agentModel: "gpt-5.4-codex", agentId: "fallback" })),
    );
    await adapter.insertAttempt(
      attemptRow(2, JSON.stringify({ agentEngine: "claude-code", agentModel: "claude-fable-5", agentId: "primary" })),
    );

    const snapshot = await getDevToolsSnapshotRoute({ adapter, runId, frameNo: 0 });
    const byNodeId = new Map(snapshot.root.children.map((child) => [child.task?.nodeId, child.task]));
    expect(byNodeId.get("exec")?.agentRan).toEqual({
      agentId: "primary",
      engine: "claude-code",
      model: "claude-fable-5",
    });
    // A never-executed node has no acting agent.
    expect(byNodeId.get("queued")?.agentRan).toBeUndefined();
    sqlite.close();
  });

  test("scopes attempt metadata to the requested frame and task iteration", async () => {
    const { adapter, sqlite } = createAdapter();
    const runId = "run-historical-attempts";
    await adapter.insertRun({ runId, workflowName: "wf", status: "running", createdAtMs: 50 });
    const frameRow = (frameNo: number, createdAtMs: number, iteration: number) => ({
      runId,
      frameNo,
      createdAtMs,
      xmlJson: canonicalizeXml({
        kind: "element",
        tag: "smithers:workflow",
        props: { name: "historical-attempts" },
        children: [{ kind: "element", tag: "smithers:task", props: { id: `exec::${iteration}` }, children: [] }],
      }),
      xmlHash: `hash-${frameNo}`,
      mountedTaskIdsJson: "[]",
      taskIndexJson: "[]",
      note: `frame-${frameNo}`,
    });
    await adapter.insertFrame(frameRow(0, 100, 0));
    await adapter.insertFrame(frameRow(1, 200, 0));
    await adapter.insertFrame(frameRow(2, 300, 1));
    const attemptRow = (iteration: number, attempt: number, startedAtMs: number, agentModel: string) => ({
      runId,
      nodeId: "exec",
      iteration,
      attempt,
      state: "finished",
      startedAtMs,
      finishedAtMs: startedAtMs + 10,
      heartbeatAtMs: null,
      heartbeatDataJson: null,
      errorJson: null,
      jjPointer: null,
      jjCwd: "/tmp",
      cached: false,
      metaJson: JSON.stringify({ agentEngine: "codex", agentModel, prompt: agentModel }),
    });
    await adapter.insertAttempt(attemptRow(0, 1, 110, "iter0-first"));
    await adapter.insertAttempt(attemptRow(0, 2, 150, "iter0-latest"));
    await adapter.insertAttempt(attemptRow(1, 1, 250, "iter1-first"));
    await adapter.insertAttempt(attemptRow(1, 2, 350, "iter1-future-retry"));

    const taskFor = async (frameNo: number) => {
      const snapshot = await getDevToolsSnapshotRoute({ adapter, runId, frameNo });
      return snapshot.root.children[0]?.task;
    };
    expect((await taskFor(0))?.agentRan).toBeUndefined();
    expect((await taskFor(0))?.prompt).toBeUndefined();
    expect((await taskFor(1))?.agentRan?.model).toBe("iter0-latest");
    expect((await taskFor(1))?.prompt).toBe("iter0-latest");
    expect((await taskFor(2))?.agentRan?.model).toBe("iter1-first");
    expect((await taskFor(2))?.prompt).toBe("iter1-first");
    sqlite.close();
  });

  test("attaches the task's initial prompt from the latest attempt's metadata", async () => {
    const { adapter, sqlite } = createAdapter();
    const runId = "run-attempt-prompts";
    await adapter.insertRun({
      runId,
      workflowName: "wf",
      status: "running",
      createdAtMs: now(),
    });
    await adapter.insertFrame({
      runId,
      frameNo: 0,
      createdAtMs: now() + 1_000,
      xmlJson: canonicalizeXml({
        kind: "element",
        tag: "smithers:workflow",
        props: { name: "attempt-prompts" },
        children: [
          { kind: "element", tag: "smithers:task", props: { id: "freeze::0" }, children: [] },
          { kind: "element", tag: "smithers:task", props: { id: "quiet::0" }, children: [] },
          { kind: "element", tag: "smithers:task", props: { id: "queued::0" }, children: [] },
        ],
      }),
      xmlHash: "hash-attempt-prompts",
      mountedTaskIdsJson: "[]",
      taskIndexJson: "[]",
      note: "attempt-prompts",
    });
    const attemptRow = (nodeId: string, attempt: number, metaJson: string | null) => ({
      runId,
      nodeId,
      iteration: 0,
      attempt,
      state: "finished",
      startedAtMs: now(),
      finishedAtMs: now(),
      heartbeatAtMs: null,
      heartbeatDataJson: null,
      errorJson: null,
      jjPointer: null,
      jjCwd: "/tmp",
      cached: false,
      metaJson,
    });
    // The LATEST attempt's prompt wins.
    await adapter.insertAttempt(attemptRow("freeze", 1, JSON.stringify({ prompt: "stale prompt" })));
    await adapter.insertAttempt(
      attemptRow("freeze", 2, JSON.stringify({ prompt: "Freeze scope for WAVAX on Avalanche C-Chain." })),
    );
    // No prompt key (or a non-string one) attaches nothing.
    await adapter.insertAttempt(attemptRow("quiet", 1, JSON.stringify({ agentEngine: "codex", prompt: null })));

    const snapshot = await getDevToolsSnapshotRoute({ adapter, runId, frameNo: 0 });
    const byNodeId = new Map(snapshot.root.children.map((child) => [child.task?.nodeId, child.task]));
    expect(byNodeId.get("freeze")?.prompt).toBe("Freeze scope for WAVAX on Avalanche C-Chain.");
    expect(byNodeId.get("quiet")?.prompt).toBeUndefined();
    expect(byNodeId.get("queued")?.prompt).toBeUndefined();
    sqlite.close();
  });

  test("bounds oversized attempt prompts carried on the snapshot", async () => {
    const { adapter, sqlite } = createAdapter();
    const runId = "run-huge-prompt";
    await adapter.insertRun({
      runId,
      workflowName: "wf",
      status: "running",
      createdAtMs: now(),
    });
    await adapter.insertFrame({
      runId,
      frameNo: 0,
      createdAtMs: now() + 1_000,
      xmlJson: canonicalizeXml({
        kind: "element",
        tag: "smithers:workflow",
        props: { name: "huge-prompt" },
        children: [{ kind: "element", tag: "smithers:task", props: { id: "big::0" }, children: [] }],
      }),
      xmlHash: "hash-huge-prompt",
      mountedTaskIdsJson: "[]",
      taskIndexJson: "[]",
      note: "huge-prompt",
    });
    await adapter.insertAttempt({
      runId,
      nodeId: "big",
      iteration: 0,
      attempt: 1,
      state: "finished",
      startedAtMs: now(),
      finishedAtMs: now(),
      heartbeatAtMs: null,
      heartbeatDataJson: null,
      errorJson: null,
      jjPointer: null,
      jjCwd: "/tmp",
      cached: false,
      metaJson: JSON.stringify({ prompt: "x".repeat(10_000) }),
    });

    const snapshot = await getDevToolsSnapshotRoute({ adapter, runId, frameNo: 0 });
    const prompt = snapshot.root.children[0]?.task?.prompt;
    expect(prompt?.length).toBe(DEVTOOLS_TASK_PROMPT_MAX_CHARS + 1);
    expect(prompt?.endsWith("…")).toBe(true);
    sqlite.close();
  });

  test("agentRan carries effort — first-class column, with meta_json fallback", async () => {
    const { adapter, sqlite } = createAdapter();
    const runId = "run-agent-effort";
    await adapter.insertRun({ runId, workflowName: "wf", status: "running", createdAtMs: now() });
    await adapter.insertFrame({
      runId,
      frameNo: 0,
      createdAtMs: now() + 1_000,
      xmlJson: canonicalizeXml({
        kind: "element",
        tag: "smithers:workflow",
        props: { name: "agent-effort" },
        children: [
          { kind: "element", tag: "smithers:task", props: { id: "col::0" }, children: [] },
          { kind: "element", tag: "smithers:task", props: { id: "legacy::0" }, children: [] },
        ],
      }),
      xmlHash: "hash-agent-effort",
      mountedTaskIdsJson: "[]",
      taskIndexJson: "[]",
    });
    for (const nodeId of ["col", "legacy"]) {
      await adapter.insertNode({
        runId,
        nodeId,
        iteration: 0,
        state: "in-progress",
        lastAttempt: 1,
        updatedAtMs: now(),
        outputTable: "",
        label: null,
      });
    }
    // `col` persisted effort to the FIRST-CLASS column (meta_json has none).
    await adapter.insertAttempt({
      runId,
      nodeId: "col",
      iteration: 0,
      attempt: 1,
      state: "in-progress",
      startedAtMs: now(),
      metaJson: JSON.stringify({ agentEngine: "claude-code", agentModel: "claude-fable-5" }),
      effort: "xhigh",
    });
    // `legacy` predates the column: effort survives only inside meta_json.
    await adapter.insertAttempt({
      runId,
      nodeId: "legacy",
      iteration: 0,
      attempt: 1,
      state: "in-progress",
      startedAtMs: now(),
      metaJson: JSON.stringify({ agentEngine: "codex", agentModel: "gpt-5", effort: "high" }),
    });

    const snapshot = await getDevToolsSnapshotRoute({ adapter, runId, frameNo: 0 });
    const byNodeId = new Map(snapshot.root.children.map((child) => [child.task?.nodeId, child.task]));
    expect(byNodeId.get("col")?.agentRan).toEqual({
      engine: "claude-code",
      model: "claude-fable-5",
      effort: "xhigh",
    });
    expect(byNodeId.get("legacy")?.agentRan).toEqual({
      engine: "codex",
      model: "gpt-5",
      effort: "high",
    });
    sqlite.close();
  });

  test("real engine run captures the declared agent end to end", async () => {
    // No mocks: a real workflow run with an agent-backed task must land the
    // declared assignment in the frame task index (engine-side capture) AND
    // the acting agent in attempt metadata, and both must surface on the
    // snapshot's task node.
    const dir = mkdtempSync(join(tmpdir(), "smithers-devtools-agent-"));
    const dbPath = join(dir, "smithers.db");
    try {
      const { smithers, Workflow, Task } = createSmithers({ out: z.object({ value: z.number() }) }, { dbPath });
      const fakeAgent = {
        id: "fake-reviewer",
        label: "Reviewer",
        cliEngine: "fake-cli",
        model: "fake-model-1",
        async generate() {
          return { output: { value: 42 } };
        },
      };
      const workflow = smithers(() => (
        <Workflow name="devtools-agent-capture">
          <Task id="review" agent={fakeAgent as never} retries={2} output="out">
            {"Review the change."}
          </Task>
        </Workflow>
      ));
      const result = await Effect.runPromise(runWorkflow(workflow, { rootDir: dir, input: {} }));
      expect(result.status).toBe("finished");
      const adapter = new SmithersDb(workflow.db);
      const snapshot = await getDevToolsSnapshotRoute({ adapter, runId: result.runId });
      const findTask = (node: any): any => {
        if (node.task?.nodeId === "review") {
          return node.task;
        }
        for (const child of node.children ?? []) {
          const found = findTask(child);
          if (found) {
            return found;
          }
        }
        return undefined;
      };
      const task = findTask(snapshot.root);
      expect(task).toBeDefined();
      // Declared assignment (path 1): render-time capture into the task index.
      expect(task.agentSummary).toEqual({
        label: "Reviewer",
        engine: "fake-cli",
        model: "fake-model-1",
      });
      // Explicit retries={2} -> attempt budget 3. (Default agent retries are
      // unbounded, which the index deliberately omits.)
      expect(task.maxAttempts).toBe(3);
      // Acting agent (path 2): attempt metadata from the executed attempt.
      expect(task.agentRan).toEqual({
        agentId: "fake-reviewer",
        engine: "fake-cli",
        model: "fake-model-1",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("real engine run persists first-class effort (column + snapshot agentRan)", async () => {
    // End-to-end: the engine derives effort from the agent at spawn, writes it
    // to the first-class `_smithers_attempts.effort` column (alongside the
    // meta_json blob), and it surfaces on the snapshot's agentRan.
    const dir = mkdtempSync(join(tmpdir(), "smithers-devtools-effort-"));
    const dbPath = join(dir, "smithers.db");
    try {
      const { smithers, Workflow, Task } = createSmithers({ out: z.object({ value: z.number() }) }, { dbPath });
      const fakeAgent = {
        id: "fake-thinker",
        label: "Thinker",
        cliEngine: "fake-cli",
        model: "fake-model-1",
        effort: "xhigh",
        async generate() {
          return { output: { value: 7 } };
        },
      };
      const workflow = smithers(() => (
        <Workflow name="devtools-effort-capture">
          <Task id="think" agent={fakeAgent as never} output="out">
            {"Think hard."}
          </Task>
        </Workflow>
      ));
      const result = await Effect.runPromise(runWorkflow(workflow, { rootDir: dir, input: {} }));
      expect(result.status).toBe("finished");
      const adapter = new SmithersDb(workflow.db);

      // First-class column populated at spawn.
      const attempts = await adapter.listAttemptsForRun(result.runId);
      const think = attempts.find((a: any) => a.nodeId === "think");
      expect(think?.effort).toBe("xhigh");

      // ...and it rides the snapshot's agentRan.
      const snapshot = await getDevToolsSnapshotRoute({ adapter, runId: result.runId });
      const findTask = (node: any): any => {
        if (node.task?.nodeId === "think") return node.task;
        for (const child of node.children ?? []) {
          const found = findTask(child);
          if (found) return found;
        }
        return undefined;
      };
      const task = findTask(snapshot.root);
      expect(task?.agentRan?.effort).toBe("xhigh");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("preserves durable human task kind from frame props", async () => {
    const { adapter, sqlite } = createAdapter();
    const runId = "run-human-kind";
    await adapter.insertRun({
      runId,
      workflowName: "wf",
      status: "waiting-approval",
      createdAtMs: now(),
    });
    await adapter.insertFrame({
      runId,
      frameNo: 0,
      createdAtMs: now(),
      xmlJson: canonicalizeXml({
        kind: "element",
        tag: "smithers:workflow",
        props: { name: "human-kind" },
        children: [
          {
            kind: "element",
            tag: "smithers:task",
            props: { id: "review::0", __smithersKind: "human", label: "human:review" },
            children: [],
          },
        ],
      }),
      xmlHash: "hash-human-kind",
      mountedTaskIdsJson: "[]",
      taskIndexJson: "[]",
      note: "human-kind",
    });

    const snapshot = await getDevToolsSnapshotRoute({ adapter, runId, frameNo: 0 });
    expect(snapshot.root.children[0]?.task).toMatchObject({
      nodeId: "review",
      kind: "human",
      label: "human:review",
      iteration: 0,
    });
    sqlite.close();
  });

  test("uses task index metadata for approval task iteration", async () => {
    const { adapter, sqlite } = createAdapter();
    const runId = "run-approval-index";
    await adapter.insertRun({
      runId,
      workflowName: "wf",
      status: "waiting-approval",
      createdAtMs: now(),
    });
    await adapter.insertFrame({
      runId,
      frameNo: 0,
      createdAtMs: now(),
      xmlJson: canonicalizeXml({
        kind: "element",
        tag: "smithers:workflow",
        props: { name: "approval-index" },
        children: [
          {
            kind: "element",
            tag: "smithers:task",
            props: {
              id: "approve-probe",
              label: "Approve E2E gated task",
              needsApproval: "true",
              approvalMode: "decision",
            },
            children: [],
          },
        ],
      }),
      xmlHash: "hash-approval-index",
      mountedTaskIdsJson: "[]",
      taskIndexJson: JSON.stringify([{ nodeId: "approve-probe", ordinal: 0, iteration: 0 }]),
      note: "approval-index",
    });

    const snapshot = await getDevToolsSnapshotRoute({ adapter, runId, frameNo: 0 });
    expect(snapshot.root.children[0]?.task).toMatchObject({
      nodeId: "approve-probe",
      kind: "approval",
      label: "Approve E2E gated task",
      iteration: 0,
    });
    sqlite.close();
  });

  test("uses task index metadata for human task kind", async () => {
    const { adapter, sqlite } = createAdapter();
    const runId = "run-human-index";
    await adapter.insertRun({
      runId,
      workflowName: "wf",
      status: "waiting-approval",
      createdAtMs: now(),
    });
    await adapter.insertFrame({
      runId,
      frameNo: 0,
      createdAtMs: now(),
      xmlJson: canonicalizeXml({
        kind: "element",
        tag: "smithers:workflow",
        props: { name: "human-index" },
        children: [
          {
            kind: "element",
            tag: "smithers:task",
            props: {
              id: "ask-probe",
              label: "human:ask-probe",
              needsApproval: "true",
              approvalMode: "decision",
            },
            children: [],
          },
        ],
      }),
      xmlHash: "hash-human-index",
      mountedTaskIdsJson: "[]",
      taskIndexJson: JSON.stringify([{ nodeId: "ask-probe", ordinal: 0, iteration: 0, kind: "human" }]),
      note: "human-index",
    });

    const snapshot = await getDevToolsSnapshotRoute({ adapter, runId, frameNo: 0 });
    expect(snapshot.root.children[0]?.task).toMatchObject({
      nodeId: "ask-probe",
      kind: "human",
      label: "human:ask-probe",
      iteration: 0,
    });
    sqlite.close();
  });

  test("validates runId boundary cases and missing runs", async () => {
    const { adapter, sqlite } = createAdapter();
    for (const runId of ["", "x".repeat(65), "../etc/passwd", "run-😀"]) {
      await expect(
        getDevToolsSnapshotRoute({
          adapter,
          runId,
        }),
      ).rejects.toMatchObject({ code: "InvalidRunId" });
    }
    await expect(
      getDevToolsSnapshotRoute({
        adapter,
        runId: "missing-run",
      }),
    ).rejects.toMatchObject({ code: "RunNotFound" });
    sqlite.close();
  });

  test("loads an engine-generated child runId", async () => {
    const { adapter, sqlite } = createAdapter();
    const runId = "parent:child:subflow-node:0";
    await adapter.insertRun({
      runId,
      workflowName: "child-wf",
      status: "running",
      createdAtMs: now(),
    });
    await adapter.insertFrame({
      runId,
      frameNo: 0,
      createdAtMs: now(),
      xmlJson: xmlFrame("child-wf", "child"),
      xmlHash: "hash-child",
      mountedTaskIdsJson: "[]",
      taskIndexJson: "[]",
      note: "child",
    });

    const snapshot = await getDevToolsSnapshotRoute({ adapter, runId, frameNo: 0 });
    expect(snapshot.runId).toBe(runId);
    sqlite.close();
  });

  test("validates frameNo boundaries", async () => {
    const { adapter, sqlite } = createAdapter();
    const runId = "run-bounds";
    await adapter.insertRun({
      runId,
      workflowName: "wf",
      status: "running",
      createdAtMs: now(),
    });
    await adapter.insertFrame({
      runId,
      frameNo: 0,
      createdAtMs: now(),
      xmlJson: xmlFrame("zero", "zero"),
      xmlHash: "hash-0",
      mountedTaskIdsJson: "[]",
      taskIndexJson: "[]",
      note: "frame-0",
    });
    await expect(getDevToolsSnapshotRoute({ adapter, runId, frameNo: -1 as any })).rejects.toMatchObject({
      code: "FrameOutOfRange",
    });
    await expect(getDevToolsSnapshotRoute({ adapter, runId, frameNo: Number.MAX_SAFE_INTEGER })).rejects.toMatchObject({
      code: "FrameOutOfRange",
    });
    await expect(getDevToolsSnapshotRoute({ adapter, runId, frameNo: 1 })).rejects.toMatchObject({
      code: "FrameOutOfRange",
    });
    const first = await getDevToolsSnapshotRoute({ adapter, runId, frameNo: 0 });
    expect(first.frameNo).toBe(0);
    sqlite.close();
  });

  test("returns empty root for runs with zero frames", async () => {
    const { adapter, sqlite } = createAdapter();
    const runId = "run-no-frames";
    await adapter.insertRun({
      runId,
      workflowName: "wf",
      status: "running",
      createdAtMs: now(),
    });
    const snapshot: DevToolsSnapshot = await getDevToolsSnapshotRoute({
      adapter,
      runId,
    });
    expect(snapshot.frameNo).toBe(0);
    expect(snapshot.root.name).toBe("(empty)");
    expect(snapshot.runState?.runId).toBe(runId);
    sqlite.close();
  });

  test("assigns stable node IDs across sibling reorder", async () => {
    const { adapter, sqlite } = createAdapter();
    const runId = "run-stable-ids";
    await adapter.insertRun({
      runId,
      workflowName: "wf",
      status: "running",
      createdAtMs: now(),
    });
    const frameWithOrder = (order: string[]) =>
      canonicalizeXml({
        kind: "element",
        tag: "smithers:workflow",
        props: { name: "stable" },
        children: order.map((id) => ({
          kind: "element" as const,
          tag: "smithers:task",
          props: { id: `${id}::0` },
          children: [] as any,
        })),
      });
    await adapter.insertFrame({
      runId,
      frameNo: 0,
      createdAtMs: now(),
      xmlJson: frameWithOrder(["a", "b"]),
      xmlHash: "hash-ab",
      mountedTaskIdsJson: "[]",
      taskIndexJson: "[]",
      note: "ab",
    });
    await adapter.insertFrame({
      runId,
      frameNo: 1,
      createdAtMs: now(),
      xmlJson: frameWithOrder(["b", "a"]),
      xmlHash: "hash-ba",
      mountedTaskIdsJson: "[]",
      taskIndexJson: "[]",
      note: "ba",
    });
    const firstSnapshot = await getDevToolsSnapshotRoute({ adapter, runId, frameNo: 0 });
    const secondSnapshot = await getDevToolsSnapshotRoute({ adapter, runId, frameNo: 1 });
    const idOf = (snap: any, taskId: string) =>
      (snap.root.children as any[]).find((child) => (child.task?.nodeId ?? "") === taskId)?.id;
    const aFirst = idOf(firstSnapshot, "a");
    const bFirst = idOf(firstSnapshot, "b");
    const aSecond = idOf(secondSnapshot, "a");
    const bSecond = idOf(secondSnapshot, "b");
    // Stable identity: the id for task "a" must match across frames even
    // though the sibling order changed. Same for "b".
    expect(aFirst).toBe(aSecond);
    expect(bFirst).toBe(bSecond);
    // And the two tasks never collide in the same frame.
    expect(aFirst).not.toBe(bFirst);
    sqlite.close();
  });

  test("handles 10MB prop strings and deep trees", async () => {
    const { adapter, sqlite } = createAdapter();
    const runId = "run-large";
    await adapter.insertRun({
      runId,
      workflowName: "wf",
      status: "running",
      createdAtMs: now(),
    });
    const largeString = "x".repeat(10 * 1024 * 1024);
    await adapter.insertFrame({
      runId,
      frameNo: 0,
      createdAtMs: now(),
      xmlJson: canonicalizeXml({
        kind: "element",
        tag: "smithers:workflow",
        props: { name: "ユニコード" },
        children: [
          {
            kind: "element",
            tag: "smithers:task",
            props: { id: "task-unicode::0", payload: largeString },
            children: [],
          },
        ],
      }),
      xmlHash: "hash-large",
      mountedTaskIdsJson: "[]",
      taskIndexJson: "[]",
      note: "large",
    });
    const large = await getDevToolsSnapshotRoute({ adapter, runId, frameNo: 0 });
    const largePayload = large.root.children[0]?.props.payload;
    expect(typeof largePayload).toBe("string");
    expect((largePayload as string).length).toBe(10 * 1024 * 1024);
    await adapter.insertFrame({
      runId,
      frameNo: 1,
      createdAtMs: now(),
      xmlJson: deepXml(1000),
      xmlHash: "hash-deep",
      mountedTaskIdsJson: "[]",
      taskIndexJson: "[]",
      note: "deep",
    });
    const deep = await getDevToolsSnapshotRoute({ adapter, runId, frameNo: 1 });
    const stack = [deep.root];
    let hasMaxDepthMarker = false;
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current.name === "[MaxDepth]") {
        hasMaxDepthMarker = true;
        break;
      }
      for (const child of current.children) {
        stack.push(child);
      }
    }
    expect(hasMaxDepthMarker).toBe(true);
    sqlite.close();
  });
});

describe("Gateway getDevToolsSnapshot RPC", () => {
  let gateway: Gateway | null = null;
  let server: any = null;
  let dbPath = "";

  beforeEach(() => {
    dbPath = join(tmpdir(), `smithers-get-devtools-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  });

  afterEach(async () => {
    if (gateway) {
      await gateway.close();
      gateway = null;
    }
    server = null;
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
  });

  test("returns snapshots over websocket RPC", async () => {
    const { smithers, Workflow, Task } = createSmithers({ out: z.object({ value: z.number() }) }, { dbPath });
    const workflow = smithers(() => (
      <Workflow name="gateway-devtools">
        <Task id="task-a">{{ value: 1 }}</Task>
      </Workflow>
    ));
    gateway = new Gateway({
      protocol: 1,
      auth: {
        mode: "token",
        tokens: {
          "op-token": {
            role: "operator",
            scopes: ["*"],
            userId: "user:test",
          },
        },
      },
    });
    gateway.register("wf", workflow);
    server = await gateway.listen({ port: 0, host: "127.0.0.1" });
    const port = (server.address() as any).port as number;
    const adapter = new SmithersDb(workflow.db);
    const runId = "run-rpc-devtools";
    await adapter.insertRun({
      runId,
      workflowName: "wf",
      status: "running",
      createdAtMs: now(),
    });
    await adapter.insertFrame({
      runId,
      frameNo: 0,
      createdAtMs: now(),
      xmlJson: xmlFrame("rpc-workflow", "rpc"),
      xmlHash: "hash-rpc",
      mountedTaskIdsJson: "[]",
      taskIndexJson: "[]",
      note: "rpc",
    });
    const client = await connectGateway(port, "op-token");
    const response = await client.request("getDevToolsSnapshot", {
      runId,
      frameNo: 0,
    });
    expect(response.ok).toBe(true);
    expect(response.payload.version).toBe(1);
    expect(response.payload.runId).toBe(runId);
    expect(response.payload.root.name).toBe("rpc-workflow");
    await client.close();
  });

  async function startAuthGateway() {
    const { smithers, Workflow, Task } = createSmithers({ out: z.object({ value: z.number() }) }, { dbPath });
    const workflow = smithers(() => (
      <Workflow name="gateway-devtools-auth">
        <Task id="task-a">{{ value: 1 }}</Task>
      </Workflow>
    ));
    gateway = new Gateway({
      protocol: 1,
      auth: {
        mode: "token",
        tokens: {
          "op-token": {
            role: "operator",
            scopes: ["*"],
            userId: "user:test",
          },
        },
      },
    });
    gateway.register("wf", workflow);
    server = await gateway.listen({ port: 0, host: "127.0.0.1" });
    const port = (server.address() as any).port as number;
    const adapter = new SmithersDb(workflow.db);
    for (const runId of ["run-x", "run-y"]) {
      await adapter.insertRun({
        runId,
        workflowName: "wf",
        status: "running",
        createdAtMs: now(),
      });
      await adapter.insertFrame({
        runId,
        frameNo: 0,
        createdAtMs: now(),
        xmlJson: xmlFrame(runId, "v"),
        xmlHash: `hash-${runId}`,
        mountedTaskIdsJson: "[]",
        taskIndexJson: "[]",
        note: "frame-0",
      });
    }
    return port;
  }

  test("denies devtools snapshot for an explicitly-empty subscribe filter", async () => {
    const port = await startAuthGateway();
    const client = await connectGateway(port, "op-token", []);
    for (const runId of ["run-x", "run-y"]) {
      const response = await client.request("getDevToolsSnapshot", {
        runId,
        frameNo: 0,
      });
      expect(response.ok).toBe(false);
      expect(response.error.code).toBe("Unauthorized");
    }
    await client.close();
  });

  test("scopes devtools snapshot to the subscribed run", async () => {
    const port = await startAuthGateway();
    const client = await connectGateway(port, "op-token", ["run-x"]);
    const allowed = await client.request("getDevToolsSnapshot", {
      runId: "run-x",
      frameNo: 0,
    });
    expect(allowed.ok).toBe(true);
    expect(allowed.payload.runId).toBe("run-x");
    const denied = await client.request("getDevToolsSnapshot", {
      runId: "run-y",
      frameNo: 0,
    });
    expect(denied.ok).toBe(false);
    expect(denied.error.code).toBe("Unauthorized");
    await client.close();
  });

  test("retains unrestricted devtools access with no subscribe filter", async () => {
    const port = await startAuthGateway();
    const client = await connectGateway(port, "op-token");
    for (const runId of ["run-x", "run-y"]) {
      const response = await client.request("getDevToolsSnapshot", {
        runId,
        frameNo: 0,
      });
      expect(response.ok).toBe(true);
      expect(response.payload.runId).toBe(runId);
    }
    await client.close();
  });
});
