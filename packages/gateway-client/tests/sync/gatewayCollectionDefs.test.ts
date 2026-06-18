import { createCollection } from "@tanstack/db";
import { describe, expect, test } from "bun:test";
import { createGatewayCollection } from "../../src/sync/createGatewayCollection.ts";
import {
  eventRows,
  gatewayCollectionDefs,
  runRowsFromFrame,
  runStatusFromFrame,
} from "../../src/sync/gatewayCollectionDefs.ts";
import type { GatewayCronRow } from "../../src/sync/GatewayCronRow.ts";
import type { GatewayMemoryFactRow } from "../../src/sync/GatewayMemoryFactRow.ts";
import type { GatewayPromptRow } from "../../src/sync/GatewayPromptRow.ts";
import type { GatewayScoreRow } from "../../src/sync/GatewayScoreRow.ts";
import type { GatewayTicketRow } from "../../src/sync/GatewayTicketRow.ts";
import type { GatewayRunNode } from "../../src/sync/GatewayRunNode.ts";
import type { GatewayRunRow } from "../../src/sync/GatewayRunRow.ts";
import type { SyncStreamFrame, SyncTransport } from "../../src/sync/SyncTransport.ts";

/** A real `cronList` payload: an array of `_smithers_cron` rows + the workflow key. */
const cronRows: GatewayCronRow[] = [
  {
    cronId: "cron_01",
    pattern: "0 8 * * 1-5",
    workflowPath: ".smithers/workflows/deploy.tsx",
    workflow: "deploy",
    enabled: true,
    createdAtMs: 1_710_000_000_000,
    lastRunAtMs: null,
    nextRunAtMs: 1_710_000_600_000,
    errorJson: null,
  },
  {
    cronId: "cron_02",
    pattern: "*/15 * * * *",
    workflowPath: ".smithers/workflows/canary.tsx",
    workflow: "canary",
    enabled: false,
    createdAtMs: 1_710_000_100_000,
    lastRunAtMs: 1_710_000_500_000,
    nextRunAtMs: null,
    errorJson: '{"error":"WorkflowNotFound"}',
  },
];

/** A real `getDevToolsSnapshot` payload: a `{ root }` tree, not an array. */
const snapshot = {
  root: {
    id: 1,
    name: "Workflow",
    type: "Workflow",
    children: [
      {
        id: 2,
        name: "Sequence",
        type: "Sequence",
        children: [
          { id: 3, name: "PlanTask", type: "Task", task: { nodeId: "plan", label: "Plan" }, children: [] },
          { id: 4, name: "Gate", type: "Approval", task: { nodeId: "approve" }, children: [] },
        ],
      },
    ],
  },
  runState: { state: "waiting-approval", blocked: { nodeId: "approve" } },
};

/**
 * A transport whose RPC returns `payload` and whose DevTools stream opens but
 * stays quiet until aborted — enough to exercise the initial load without
 * spinning the reconnect loop.
 */
function quietTransport(payload: unknown): SyncTransport {
  return {
    rpc() {
      return Promise.resolve(payload);
    },
    stream(_scope: string, _params: unknown, options: { signal?: AbortSignal }): AsyncIterable<SyncStreamFrame> {
      return {
        async *[Symbol.asyncIterator]() {
          await new Promise<void>((resolve) => {
            if (options.signal?.aborted) return resolve();
            options.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        },
      };
    },
  };
}

describe("gatewayCollectionDefs.nodes", () => {
  test("rows mapper flattens a real { root } snapshot into node rows", () => {
    const rows = Array.from(gatewayCollectionDefs.nodes("run-1").rows(snapshot));
    expect(rows.map((row) => row.id)).toEqual(["1", "2", "plan", "approve"]);
    expect(rows.find((row) => row.id === "1")?.childIds).toEqual(["2"]);
    expect(rows.find((row) => row.id === "2")?.childIds).toEqual(["plan", "approve"]);
    expect(rows.find((row) => row.id === "plan")).toMatchObject({ kind: "agent", parentId: "2", childIds: [] });
    expect(rows.find((row) => row.id === "approve")).toMatchObject({ kind: "approval", status: "waiting" });
  });

  test("honors a caller-supplied rows mapper", () => {
    const custom = (): GatewayRunNode[] => [{ id: "x", name: "X", kind: "compute", status: "ok" }];
    expect(gatewayCollectionDefs.nodes("run-1", custom).rows).toBe(custom);
  });

  test("populates a TanStack DB collection from the snapshot RPC", async () => {
    const collection = createCollection<GatewayRunNode, string>(
      createGatewayCollection({ ...gatewayCollectionDefs.nodes("run-1"), client: quietTransport(snapshot) }),
    );

    await collection.preload();

    expect(Array.from(collection.keys()).sort()).toEqual(["1", "2", "approve", "plan"]);
    expect(collection.get("approve")?.status).toBe("waiting");
    expect(collection.get("plan")?.parentId).toBe("2");
  });

  test("stays empty for the gateway empty-root placeholder", async () => {
    const collection = createCollection<GatewayRunNode, string>(
      createGatewayCollection({
        ...gatewayCollectionDefs.nodes("run-1"),
        client: quietTransport({ root: { id: 0, name: "(empty)", children: [] } }),
      }),
    );

    await collection.preload();

    expect(collection.size).toBe(0);
    expect(collection.status).toBe("ready");
  });
});

describe("gatewayCollectionDefs", () => {
  test("defines workflow, run list, run, approvals, and run event collections", () => {
    const workflows = gatewayCollectionDefs.workflows({ filter: { hasUi: true } });
    expect(workflows).toMatchObject({
      key: ["gateway:listWorkflows", { hasUi: true }],
      method: "listWorkflows",
      params: { filter: { hasUi: true } },
    });
    expect(workflows.getKey({ key: "wf", name: "Workflow" } as never)).toBe("wf");
    expect(workflows.rows([{ key: "wf" }])).toEqual([{ key: "wf" }]);
    expect(workflows.rows({ key: "wf" })).toEqual([]);

    const runs = gatewayCollectionDefs.runs({ workflowKey: "wf" });
    expect(runs).toMatchObject({
      key: ["gateway:listRuns", { workflowKey: "wf" }],
      method: "listRuns",
      params: { workflowKey: "wf" },
    });
    expect(runs.getKey({ runId: "run-1" })).toBe("run-1");
    expect(runs.rows([{ runId: "run-1" }])).toEqual([{ runId: "run-1" }]);

    const run = gatewayCollectionDefs.run("run-1");
    expect(run).toMatchObject({
      key: ["gateway:getRun", { runId: "run-1" }],
      method: "getRun",
      params: { runId: "run-1" },
      stream: { scope: "streamRunEvents", params: { runId: "run-1" } },
    });
    expect(run.getKey({ runId: "run-1" })).toBe("run-1");
    expect(run.rows({ runId: "run-1", status: "running" })).toEqual([{ runId: "run-1", status: "running" }]);
    expect(run.rows([{ runId: "run-1" }])).toEqual([]);

    const approvals = gatewayCollectionDefs.approvals({ runId: "run-1" });
    expect(approvals).toMatchObject({
      key: ["gateway:listApprovals", { runId: "run-1" }],
      method: "listApprovals",
      params: { runId: "run-1" },
    });
    expect(approvals.getKey({ runId: "run-1", nodeId: "approve", iteration: 2 } as never)).toBe("run-1:approve:2");
    expect(approvals.rows([{ runId: "run-1", nodeId: "approve", iteration: 2 }])).toEqual([
      { runId: "run-1", nodeId: "approve", iteration: 2 },
    ]);

    const runEvents = gatewayCollectionDefs.runEvents("run-1", 2);
    expect(runEvents).toMatchObject({
      key: ["gateway:streamRunEvents", { runId: "run-1" }],
      stream: { scope: "streamRunEvents", params: { runId: "run-1" }, maxRows: 2 },
    });
    expect(runEvents.getKey({ key: ["gateway:streamRunEvents", { runId: "run-1" }], seq: 12, event: "event", payload: {} })).toBe(12);
  });
});

describe("gateway run stream frame mappers", () => {
  test("maps run event frames only when a sequence is present", () => {
    const keyedFrame = {
      key: ["gateway:streamRunEvents", { runId: "run-1" }],
      seq: 11,
      event: "gateway.event",
      payload: { event: "run.started", payload: { runId: "run-1" } },
    } as const;

    expect(eventRows(keyedFrame)).toEqual([
      {
        key: ["gateway:streamRunEvents", { runId: "run-1" }],
        seq: 11,
        event: "gateway.event",
        payload: { event: "run.started", payload: { runId: "run-1" } },
      },
    ]);
    expect(eventRows({ ...keyedFrame, seq: undefined })).toEqual([]);
  });

  test("maps gateway run lifecycle events to run statuses", () => {
    expect(runStatusFromFrame({ payload: { event: "run.started", payload: {} } })).toBe("running");
    expect(runStatusFromFrame({ payload: { event: "run.resumed", payload: {} } })).toBe("running");
    expect(runStatusFromFrame({ payload: { event: "run.paused", payload: {} } })).toBe("waiting");
    expect(runStatusFromFrame({ payload: { event: "run.completed", payload: { state: "ok" } } })).toBe("ok");
    expect(runStatusFromFrame({ payload: { event: "run.completed", payload: { status: "succeeded" } } })).toBe("succeeded");
    expect(runStatusFromFrame({ payload: { event: "run.completed", payload: { state: "failed" } } })).toBe("failed");
    expect(runStatusFromFrame({ payload: { event: "run.completed", payload: { state: "cancelled" } } })).toBe("failed");
    expect(runStatusFromFrame({ payload: { event: "run.completed", payload: {} } })).toBe("ok");
    expect(runStatusFromFrame({ payload: { event: "node.started", payload: {} } })).toBeUndefined();
    expect(runStatusFromFrame({ payload: null })).toBeUndefined();
  });

  test("updates the current run row and omits virtual fields", () => {
    const current: GatewayRunRow = {
      runId: "run-1",
      status: "waiting",
      workflowKey: "wf",
      $optimistic: true,
      summary: undefined,
    };
    const mapper = runRowsFromFrame("run-1");
    const collection = {
      get(key: string) {
        return key === "run-1" ? current : undefined;
      },
    };

    expect(mapper(
      { payload: { event: "run.started", payload: {} } },
      { collection: collection as never },
    )).toEqual([{ runId: "run-1", status: "running", workflowKey: "wf" }]);
    expect(mapper(
      { payload: { event: "node.started", payload: {} } },
      { collection: collection as never },
    )).toEqual([]);
    expect(runRowsFromFrame("missing")(
      { payload: { event: "run.started", payload: {} } },
      { collection: collection as never },
    )).toEqual([]);
  });
});

describe("gatewayCollectionDefs.crons", () => {
  test("rows mapper passes a cronList array through and keys by cronId", () => {
    const def = gatewayCollectionDefs.crons();
    const rows = Array.from(def.rows(cronRows));
    expect(rows.map((row) => row.cronId)).toEqual(["cron_01", "cron_02"]);
    expect(def.getKey(rows[0])).toBe("cron_01");
    // Disabled rows survive (cronList returns enabled + disabled).
    expect(rows[1].enabled).toBe(false);
    expect(rows[1].errorJson).toBe('{"error":"WorkflowNotFound"}');
  });

  test("a non-array payload maps to no rows", () => {
    expect(Array.from(gatewayCollectionDefs.crons().rows({ not: "an array" }))).toEqual([]);
  });

  test("populates a TanStack DB collection from the cronList RPC", async () => {
    const collection = createCollection<GatewayCronRow, string>(
      createGatewayCollection({ ...gatewayCollectionDefs.crons(), client: quietTransport(cronRows) }),
    );

    await collection.preload();

    expect(Array.from(collection.keys()).sort()).toEqual(["cron_01", "cron_02"]);
    expect(collection.get("cron_01")?.workflow).toBe("deploy");
    expect(collection.get("cron_02")?.enabled).toBe(false);
    expect(collection.get("cron_02")?.nextRunAtMs).toBeNull();
  });
});

/** A real `listMemoryFacts` payload: `_smithers_memory_facts` rows (snake→camel cased). */
const memoryFactRows: GatewayMemoryFactRow[] = [
  {
    namespace: "ci",
    key: "token-ttl-rotation",
    valueJson: '"rotation must use a fixed ROTATE_TTL"',
    schemaSig: null,
    createdAtMs: 1_717_000_000_000,
    updatedAtMs: 1_717_286_000_000,
    ttlMs: 3_600_000,
  },
  {
    namespace: "auth",
    key: "session-sync-signing",
    valueJson: '{"sync":true}',
    schemaSig: null,
    createdAtMs: 1_716_000_000_000,
    updatedAtMs: 1_717_286_400_000,
    ttlMs: null,
  },
];

describe("gatewayCollectionDefs.memoryFacts", () => {
  test("rows mapper passes a listMemoryFacts array through and keys by namespace+key", () => {
    const def = gatewayCollectionDefs.memoryFacts();
    const rows = Array.from(def.rows(memoryFactRows));
    expect(rows.map((row) => row.key)).toEqual(["token-ttl-rotation", "session-sync-signing"]);
    // `_smithers_memory_facts` is keyed by `(namespace, key)` and an unfiltered
    // `listMemoryFacts` returns every namespace, so the collection key must be the
    // composite — `key` alone collides across namespaces.
    expect(def.getKey(rows[0])).toBe("ci:token-ttl-rotation");
    // A non-expiring fact carries a null ttl (load-bearing for the detail pane).
    expect(rows[1].ttlMs).toBeNull();
  });

  test("a non-array payload maps to no rows", () => {
    expect(Array.from(gatewayCollectionDefs.memoryFacts().rows({ not: "an array" }))).toEqual([]);
  });

  test("populates a TanStack DB collection from the listMemoryFacts RPC", async () => {
    const collection = createCollection<GatewayMemoryFactRow, string>(
      createGatewayCollection({ ...gatewayCollectionDefs.memoryFacts(), client: quietTransport(memoryFactRows) }),
    );

    await collection.preload();

    expect(Array.from(collection.keys()).sort()).toEqual(["auth:session-sync-signing", "ci:token-ttl-rotation"]);
    expect(collection.get("ci:token-ttl-rotation")?.namespace).toBe("ci");
    expect(collection.get("ci:token-ttl-rotation")?.ttlMs).toBe(3_600_000);
    expect(collection.get("auth:session-sync-signing")?.ttlMs).toBeNull();
  });

  test("same key in two namespaces does NOT collide (composite key)", async () => {
    // Regression guard: keying by `key` alone dropped one of these rows.
    const collidingRows: GatewayMemoryFactRow[] = [
      { namespace: "ci", key: "shared", valueJson: '"from ci"', schemaSig: null, createdAtMs: 1, updatedAtMs: 1, ttlMs: null },
      { namespace: "auth", key: "shared", valueJson: '"from auth"', schemaSig: null, createdAtMs: 2, updatedAtMs: 2, ttlMs: null },
    ];
    const collection = createCollection<GatewayMemoryFactRow, string>(
      createGatewayCollection({ ...gatewayCollectionDefs.memoryFacts(), client: quietTransport(collidingRows) }),
    );

    await collection.preload();

    expect(Array.from(collection.keys()).sort()).toEqual(["auth:shared", "ci:shared"]);
    expect(collection.get("ci:shared")?.valueJson).toBe('"from ci"');
    expect(collection.get("auth:shared")?.valueJson).toBe('"from auth"');
  });
});

/** A real `listPrompts` payload: `.smithers/prompts/**.{md,mdx}` files walked from disk. */
const promptRows: GatewayPromptRow[] = [
  {
    id: "refactor",
    entryFile: "prompts/refactor.mdx",
    source: "# Refactor\n\nRefactor {{file}}.",
    createdAtMs: 1_717_000_000_000,
    updatedAtMs: 1_717_286_000_000,
  },
  {
    id: "release-content/changelog",
    entryFile: "prompts/release-content/changelog.md",
    source: "# Changelog\n\nSummarize {{range}}.",
    createdAtMs: 1_716_000_000_000,
    updatedAtMs: 1_717_286_400_000,
  },
];

describe("gatewayCollectionDefs.prompts", () => {
  test("rows mapper passes a listPrompts array through and keys by entryFile", () => {
    const def = gatewayCollectionDefs.prompts();
    const rows = Array.from(def.rows(promptRows));
    expect(rows.map((row) => row.id)).toEqual(["refactor", "release-content/changelog"]);
    // `entryFile` (the relative source path WITH extension) is the PK — it is
    // 1:1 with a real file, so `foo.md`/`foo.mdx` (same `id`) do not collide.
    // Nested-dir prompts carry a slash in `entryFile` and must round-trip.
    expect(def.getKey(rows[0])).toBe("prompts/refactor.mdx");
    expect(def.getKey(rows[1])).toBe("prompts/release-content/changelog.md");
  });

  test("a non-array payload maps to no rows", () => {
    expect(Array.from(gatewayCollectionDefs.prompts().rows({ not: "an array" }))).toEqual([]);
  });

  test("populates a TanStack DB collection from the listPrompts RPC", async () => {
    const collection = createCollection<GatewayPromptRow, string>(
      createGatewayCollection({ ...gatewayCollectionDefs.prompts(), client: quietTransport(promptRows) }),
    );

    await collection.preload();

    expect(Array.from(collection.keys()).sort()).toEqual([
      "prompts/refactor.mdx",
      "prompts/release-content/changelog.md",
    ]);
    expect(collection.get("prompts/refactor.mdx")?.id).toBe("refactor");
    expect(collection.get("prompts/release-content/changelog.md")?.source).toContain("Changelog");
  });

  test("same extensionless id with different extensions does NOT collide (both survive)", async () => {
    // Regression guard for the [P2] collision: `foo.md` and `foo.mdx` both strip
    // to id `foo`, so keying the collection by `id` dropped one valid prompt.
    // Keying by `entryFile` (unique per file) keeps BOTH rows.
    const collidingRows: GatewayPromptRow[] = [
      { id: "foo", entryFile: "prompts/foo.md", source: "# md foo", createdAtMs: 1, updatedAtMs: 1 },
      { id: "foo", entryFile: "prompts/foo.mdx", source: "# mdx foo", createdAtMs: 2, updatedAtMs: 2 },
    ];
    const def = gatewayCollectionDefs.prompts();
    // The keys differ even though the ids are identical.
    expect(def.getKey(collidingRows[0])).toBe("prompts/foo.md");
    expect(def.getKey(collidingRows[1])).toBe("prompts/foo.mdx");

    const collection = createCollection<GatewayPromptRow, string>(
      createGatewayCollection({ ...gatewayCollectionDefs.prompts(), client: quietTransport(collidingRows) }),
    );

    await collection.preload();

    expect(Array.from(collection.keys()).sort()).toEqual(["prompts/foo.md", "prompts/foo.mdx"]);
    expect(collection.get("prompts/foo.md")?.source).toBe("# md foo");
    expect(collection.get("prompts/foo.mdx")?.source).toBe("# mdx foo");
  });
});

/** A real `listScores` payload: `_smithers_scorers` rows for one run (snake→camel cased). */
const scoreRows: GatewayScoreRow[] = [
  {
    runId: "run_7a3f",
    nodeId: "review",
    iteration: 0,
    attempt: 0,
    scorerId: "correctness",
    scorerName: "correctness",
    source: "scorer",
    score: 0.92,
    reason: "All assertions passed.",
    scoredAtMs: 1_717_286_000_000,
    latencyMs: 4_120,
    durationMs: 5_010,
  },
  {
    runId: "run_7a3f",
    nodeId: "review",
    iteration: 1,
    attempt: 0,
    scorerId: "correctness",
    scorerName: "correctness",
    source: "scorer",
    score: 0.88,
    reason: null,
    scoredAtMs: 1_717_286_100_000,
    latencyMs: null,
    durationMs: null,
  },
];

describe("gatewayCollectionDefs.scores", () => {
  test("rows mapper passes a listScores array through and keys by runId:nodeId:iteration:scorerId", () => {
    const def = gatewayCollectionDefs.scores({ runId: "run_7a3f" });
    const rows = Array.from(def.rows(scoreRows));
    expect(rows.map((row) => row.score)).toEqual([0.92, 0.88]);
    // The same scorer at the same node but a DIFFERENT iteration must NOT
    // collide — the composite key includes the iteration.
    expect(def.getKey(rows[0])).toBe("run_7a3f:review:0:correctness");
    expect(def.getKey(rows[1])).toBe("run_7a3f:review:1:correctness");
    // A row with no timing carries null latency/duration (the no-data branch).
    expect(rows[1].latencyMs).toBeNull();
    expect(rows[1].durationMs).toBeNull();
  });

  test("a non-array payload maps to no rows", () => {
    expect(Array.from(gatewayCollectionDefs.scores({ runId: "x" }).rows({ not: "an array" }))).toEqual([]);
  });

  test("populates a TanStack DB collection from the listScores RPC", async () => {
    const collection = createCollection<GatewayScoreRow, string>(
      createGatewayCollection({ ...gatewayCollectionDefs.scores({ runId: "run_7a3f" }), client: quietTransport(scoreRows) }),
    );

    await collection.preload();

    expect(Array.from(collection.keys()).sort()).toEqual([
      "run_7a3f:review:0:correctness",
      "run_7a3f:review:1:correctness",
    ]);
    expect(collection.get("run_7a3f:review:0:correctness")?.score).toBe(0.92);
    expect(collection.get("run_7a3f:review:0:correctness")?.latencyMs).toBe(4_120);
    expect(collection.get("run_7a3f:review:1:correctness")?.reason).toBeNull();
  });

  test("same scorer at the same node+iteration but different attempts collapses (run-level identity)", async () => {
    // The run-level view collapses repeated attempts of the same
    // scorer-at-node-iteration — last attempt wins on the shared composite key.
    const attempts: GatewayScoreRow[] = [
      { runId: "r", nodeId: "n", iteration: 0, attempt: 0, scorerId: "s", scorerName: "s", source: "scorer", score: 0.4, scoredAtMs: 1, latencyMs: null, durationMs: null },
      { runId: "r", nodeId: "n", iteration: 0, attempt: 1, scorerId: "s", scorerName: "s", source: "scorer", score: 0.9, scoredAtMs: 2, latencyMs: null, durationMs: null },
    ];
    const collection = createCollection<GatewayScoreRow, string>(
      createGatewayCollection({ ...gatewayCollectionDefs.scores({ runId: "r" }), client: quietTransport(attempts) }),
    );

    await collection.preload();

    expect(Array.from(collection.keys())).toEqual(["r:n:0:s"]);
    expect(collection.get("r:n:0:s")?.score).toBe(0.9);
  });
});

/** A real `listTickets` payload: live `_smithers_docs` rows (tombstones already filtered server-side). */
const ticketRows: GatewayTicketRow[] = [
  {
    path: "feat-issues-card",
    kind: "ticket",
    content: "# Issues card\n\n## Summary\nPort the tickets view.",
    contentHash: "a".repeat(64),
    status: "in-progress",
    updatedAtMs: 1_717_286_100_000,
  },
  {
    path: "docs-markdown-editor",
    kind: "ticket",
    content: "# Markdown editor docs",
    contentHash: "b".repeat(64),
    status: null,
    updatedAtMs: 1_717_286_000_000,
  },
];

describe("gatewayCollectionDefs.tickets", () => {
  test("rows mapper passes a listTickets array through and keys by path", () => {
    const def = gatewayCollectionDefs.tickets({ kind: "ticket" });
    const rows = Array.from(def.rows(ticketRows));
    expect(rows.map((row) => row.path)).toEqual(["feat-issues-card", "docs-markdown-editor"]);
    expect(def.getKey(rows[0])).toBe("feat-issues-card");
    // A null status survives the passthrough (the no-status branch).
    expect(rows[1].status).toBeNull();
  });

  test("a non-array payload maps to no rows", () => {
    expect(Array.from(gatewayCollectionDefs.tickets().rows({ not: "an array" }))).toEqual([]);
  });

  test("populates a TanStack DB collection from the listTickets RPC, keyed by path", async () => {
    const collection = createCollection<GatewayTicketRow, string>(
      createGatewayCollection({ ...gatewayCollectionDefs.tickets(), client: quietTransport(ticketRows) }),
    );

    await collection.preload();

    expect(Array.from(collection.keys()).sort()).toEqual(["docs-markdown-editor", "feat-issues-card"]);
    expect(collection.get("feat-issues-card")?.status).toBe("in-progress");
    expect(collection.get("feat-issues-card")?.contentHash).toBe("a".repeat(64));
  });
});
