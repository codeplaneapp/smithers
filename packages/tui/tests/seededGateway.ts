type Server = ReturnType<typeof Bun.serve>;

/**
 * A REAL in-process gateway HTTP server seeded with deterministic data, speaking
 * the exact `/v1/api/*` + `/v1/rpc/*` envelope contract the gateway data-client
 * fetches. This is NOT a mock of the client: the production
 * `SmithersGatewayClient` + `createSmithersDataClient` + tanstack-db collections
 * all run unchanged against it, so the TUI's gateway hooks exercise their real
 * fetch/stream/reconcile paths. Only the transport target is a local fixture.
 */
export type ApprovalRow = {
  runId: string;
  nodeId: string;
  iteration: number;
  requestTitle?: string;
  requestSummary?: string;
  requestedAtMs: number | null;
  approvalMode?: string;
  options?: unknown;
};

export type SnapshotNode = {
  id: number | string;
  name: string;
  type?: string;
  props?: Record<string, unknown>;
  task?: { nodeId?: string; kind?: string; label?: string; iteration?: number };
  children?: SnapshotNode[];
};

export type GatewaySeed = {
  run: Record<string, unknown>;
  snapshot: { root?: SnapshotNode; runState?: { state?: string; blocked?: { nodeId?: string } } };
  events: Array<{ runId: string; seq: number; event: string; payload?: unknown }>;
  approvals: ApprovalRow[];
  nodeOutput: Record<string, unknown>;
  nodeDiff: unknown;
  /** Force the tree endpoint to 500 so useRunTree surfaces its error state. */
  failTree?: boolean;
  /** Force submitApproval to error so the submit onError path runs. */
  failApproval?: boolean;
};

export type SeededGateway = {
  server: Server;
  baseUrl: string;
  seed: GatewaySeed;
  /** Every submitApproval body the UI POSTed, in order. */
  submittedApprovals: Array<Record<string, unknown>>;
  stop: () => void;
};

function apiOk(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, data }), {
    headers: { "content-type": "application/json" },
  });
}

function rpcOk(payload: unknown): Response {
  return new Response(JSON.stringify({ type: "res", id: "1", ok: true, payload }), {
    headers: { "content-type": "application/json" },
  });
}

export function startSeededGateway(seed: GatewaySeed): SeededGateway {
  const submittedApprovals: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      // Health probe.
      if (path === "/health") return new Response("ok");

      // SSE change stream: stay open so the data-client reports "online" and the
      // TUI shows a live/streaming state. Never emits (initial collection fetches
      // already deliver the seeded rows); closes when the server stops.
      if (path === "/v1/api/stream") {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(": connected\n\n"));
          },
        });
        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          },
        });
      }

      // getNodeDiff RPC (used by the Diff tab via useGatewayRpc → client.rpc).
      if (path === "/v1/rpc/getNodeDiff") return rpcOk(seed.nodeDiff);
      // getRun/runs.get RPC: the CLI startup path (packages/tui/src/index.tsx's
      // gatewayServesRun) POSTs this before rendering anything, and requires a
      // truthy payload to confirm this gateway actually serves the run.
      if (path === "/v1/rpc/getRun" || path === "/v1/rpc/runs.get") return rpcOk(seed.run);
      if (path.startsWith("/v1/rpc/")) return rpcOk(null);

      // Tree snapshot.
      const treeMatch = path.match(/^\/v1\/api\/runs\/[^/]+\/tree$/);
      if (treeMatch) {
        if (seed.failTree) {
          return new Response(JSON.stringify({ ok: false, error: { message: "tree exploded" } }), {
            status: 500,
            headers: { "content-type": "application/json" },
          });
        }
        return apiOk(seed.snapshot);
      }

      // Single run row.
      const runMatch = path.match(/^\/v1\/api\/runs\/[^/]+$/);
      if (runMatch && req.method === "GET") return apiOk(seed.run);

      // Run events.
      if (path === "/v1/api/events") return apiOk(seed.events);

      // Approvals list + submit.
      if (path === "/v1/api/approvals" && req.method === "GET") return apiOk(seed.approvals);
      if (path.startsWith("/v1/api/approvals/") && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        submittedApprovals.push(body);
        if (seed.failApproval) {
          return new Response(JSON.stringify({ ok: false, error: { message: "approval rejected" } }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        // Emulate the gateway acknowledging the decision.
        return apiOk({ ok: true });
      }

      // Node output.
      if (/^\/v1\/api\/nodes\/[^/]+\/[^/]+\/output$/.test(path)) return apiOk(seed.nodeOutput);
      if (/^\/v1\/api\/nodes\/[^/]+\/[^/]+\/diff$/.test(path)) return apiOk(seed.nodeDiff);

      // Everything else the collections might probe: empty arrays / null.
      return apiOk([]);
    },
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  return {
    server,
    baseUrl,
    seed,
    submittedApprovals,
    stop: () => server.stop(true),
  };
}

export type SeedOptions = {
  /** Approval mode for the `approve` node (default gate). */
  approvalMode?: string;
  /** Options for a select/rank approval. */
  approvalOptions?: unknown;
  /** When set, the run is blocked on this node id (drives waiting status). */
  blockedNodeId?: string;
  /** Run-level state (default running). */
  runState?: string;
  /** Omit the approval row entirely (empty approvals list). */
  noApproval?: boolean;
};

/** A representative seed: a running workflow with a task, an approval, and a human node. */
export function defaultSeed(runId: string, opts: SeedOptions = {}): GatewaySeed {
  const runState = opts.runState ?? "running";
  return {
    run: {
      runId,
      status: runState,
      workflowKey: "deploy-flow",
      model: "opus",
      startedAtMs: Date.now() - 5000,
    },
    snapshot: {
      runState: { state: runState, ...(opts.blockedNodeId ? { blocked: { nodeId: opts.blockedNodeId } } : {}) },
      root: {
        id: 0,
        name: "deploy-flow",
        type: "workflow",
        task: { nodeId: "root" },
        children: [
          {
            id: 1,
            name: "fetch-data",
            type: "task",
            task: { nodeId: "fetch-data", kind: "agent", iteration: 0 },
          },
          {
            id: 2,
            name: "approve-deploy",
            type: "approval",
            task: { nodeId: "approve", kind: "approval", iteration: 0 },
          },
          {
            id: 3,
            name: "ask-user",
            type: "task",
            props: { __smithersKind: "human" },
            task: { nodeId: "ask", kind: "human", iteration: 0 },
          },
        ],
      },
    },
    events: [
      { runId, seq: 1, event: "run.start", payload: {} },
      { runId, seq: 2, event: "node.start", payload: { nodeId: "fetch-data", name: "fetch-data" } },
      { runId, seq: 3, event: "tool.use", payload: { nodeId: "fetch-data", toolName: "read_file" } },
      { runId, seq: 4, event: "agent.message", payload: { nodeId: "fetch-data", text: "working" } },
    ],
    approvals: opts.noApproval
      ? []
      : [
          {
            runId,
            nodeId: "approve",
            iteration: 0,
            requestTitle: "Approve deploy",
            requestSummary: "Ship v1.2.3 to prod?",
            requestedAtMs: Date.now(),
            approvalMode: opts.approvalMode ?? "gate",
            options: opts.approvalOptions ?? [],
          },
        ],
    nodeOutput: { output: { result: "ok" } },
    // A stat-only diff payload (see diffUtils.toNodeDiffView): renders the
    // Tree inspector's "stat" diff branch.
    nodeDiff: { summary: { filesChanged: 1, added: 2, removed: 0, files: [{ path: "a.ts", added: 2, removed: 0 }] } },
  };
}

/** A seed whose run has no frames yet: the gateway returns the empty-root sentinel. */
export function emptySeed(runId: string): GatewaySeed {
  return {
    run: { runId, status: "running", workflowKey: "empty-flow", startedAtMs: Date.now() },
    snapshot: { runState: { state: "running" }, root: { id: 0, name: "(empty)", type: "workflow" } },
    events: [],
    approvals: [],
    nodeOutput: {},
    nodeDiff: { kind: "empty", message: "No diff." },
  };
}
