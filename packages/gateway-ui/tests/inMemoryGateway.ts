// A REAL in-memory Smithers gateway over real HTTP (Bun.serve). It implements
// the `/v1/api/*` REST + SSE contract the local-mode SmithersDataClient speaks,
// backed by seeded in-memory state — no engine, no mocks. The gateway-ui hook
// components render against this exactly as they would against a live gateway:
// real client, real @tanstack/react-db collections, real fetch, real SSE.

// This module is imported (and evaluated) before the test file registers
// happy-dom, so these globals are still Bun's native implementations. Bun.serve
// requires native Response/ReadableStream instances; the happy-dom replacements
// installed later would be rejected, so we pin the natives here.
const NativeResponse = globalThis.Response;
const NativeReadableStream = globalThis.ReadableStream;

export type SeedState = {
  runs?: Array<Record<string, unknown>>;
  approvals?: Array<Record<string, unknown>>;
  workflows?: Array<Record<string, unknown>>;
  events?: Record<string, Array<Record<string, unknown>>>;
  trees?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  /** Optional response delay by `runId:nodeId`, used to exercise loading transitions. */
  outputDelayMs?: Record<string, number>;
  /** Endpoints (by pathname) that should answer with an HTTP error envelope. */
  failPaths?: Set<string>;
  /** When set, the SSE stream endpoint answers with this HTTP status. */
  streamStatus?: number;
  /** When true, POST /v1/api/approvals/:id (submitApproval) always fails. */
  failApprovalSubmit?: boolean;
  /** When true, submitApproval hangs until releaseApprovalSubmits() is called. */
  deferApprovalSubmit?: boolean;
};

export type InMemoryGateway = {
  baseUrl: string;
  seq: number;
  state: Required<Omit<SeedState, "failPaths" | "streamStatus">> & {
    failPaths: Set<string>;
    streamStatus: number;
    approvalSubmitWaiters: Array<() => void>;
  };
  launches: Array<{ workflow: string; input: unknown }>;
  approvalsSubmitted: Array<Record<string, unknown>>;
  /** Every rewindRun body the UI POSTed, in order. */
  rewinds: Array<Record<string, unknown>>;
  /** Append rows to a run's event log after mount and notify SSE subscribers. */
  pushEvents(runId: string, rows: Array<Record<string, unknown>>): void;
  /** Resolve every held submitApproval and stop deferring new ones. */
  releaseApprovalSubmits(): void;
  close(): Promise<void>;
};

function ok(data: unknown, extra: Record<string, unknown> = {}): Response {
  return NativeResponse.json({ ok: true, data, ...extra });
}

function fail(status: number, code: string, message: string): Response {
  return NativeResponse.json({ ok: false, error: { code, message } }, { status });
}

export function startInMemoryGateway(seed: SeedState = {}): InMemoryGateway {
  const state = {
    runs: seed.runs ?? [],
    approvals: seed.approvals ?? [],
    workflows: seed.workflows ?? [],
    events: seed.events ?? {},
    trees: seed.trees ?? {},
    outputs: seed.outputs ?? {},
    outputDelayMs: seed.outputDelayMs ?? {},
    failPaths: seed.failPaths ?? new Set<string>(),
    streamStatus: seed.streamStatus ?? 200,
    failApprovalSubmit: seed.failApprovalSubmit ?? false,
    deferApprovalSubmit: seed.deferApprovalSubmit ?? false,
    approvalSubmitWaiters: [] as Array<() => void>,
  };

  const controllers = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();
  let seq = 0;

  const broadcast = (collections: string[]) => {
    seq += 1;
    const frame = `event: change\ndata: ${JSON.stringify({ seq, collections })}\n\n`;
    for (const controller of controllers) {
      try {
        controller.enqueue(encoder.encode(frame));
      } catch {
        /* controller already closed */
      }
    }
    return seq;
  };

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname;

      if (path === "/v1/api/stream") {
        if (state.streamStatus !== 200) {
          return new NativeResponse("stream error", { status: state.streamStatus });
        }
        const stream = new NativeReadableStream<Uint8Array>({
          start(controller) {
            controllers.add(controller);
            controller.enqueue(encoder.encode(": connected\n\n"));
            request.signal.addEventListener("abort", () => {
              controllers.delete(controller);
              try {
                controller.close();
              } catch {
                /* already closed */
              }
            });
          },
          cancel() {
            /* reader gone */
          },
        });
        return new NativeResponse(stream, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          },
        });
      }

      if (state.failPaths.has(path)) {
        return fail(500, "BOOM", `Forced failure for ${path}`);
      }

      // GET /v1/api/runs
      if (path === "/v1/api/runs" && request.method === "GET") {
        return ok(state.runs);
      }
      // GET /v1/api/runs/:id (getRun)
      const runMatch = path.match(/^\/v1\/api\/runs\/([^/]+)$/);
      if (runMatch && request.method === "GET") {
        const runId = decodeURIComponent(runMatch[1]!);
        const run = state.runs.find((row) => row.runId === runId);
        return run ? ok(run) : fail(404, "NOT_FOUND", `No run ${runId}`);
      }
      // POST /v1/api/runs (launchRun)
      if (path === "/v1/api/runs" && request.method === "POST") {
        const body = (await request.json().catch(() => ({}))) as { workflow?: string; input?: unknown };
        const runId = `run-${state.runs.length + 1}`;
        state.runs = [{ runId, workflowKey: body.workflow, status: "running", createdAtMs: Date.now() }, ...state.runs];
        gateway.launches.push({ workflow: body.workflow ?? "", input: body.input });
        const emitted = broadcast(["runs"]);
        return ok({ runId }, { seq: emitted });
      }
      // POST /v1/api/runs/:id/rewind (rewindRun)
      const rewindMatch = path.match(/^\/v1\/api\/runs\/([^/]+)\/rewind$/);
      if (rewindMatch && request.method === "POST") {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        gateway.rewinds.push(body);
        const emitted = broadcast(["runs"]);
        return ok({ runId: decodeURIComponent(rewindMatch[1]!), rewound: true }, { seq: emitted });
      }
      // GET /v1/api/runs/:id/tree
      const treeMatch = path.match(/^\/v1\/api\/runs\/([^/]+)\/tree$/);
      if (treeMatch && request.method === "GET") {
        const runId = decodeURIComponent(treeMatch[1]!);
        return ok(state.trees[runId] ?? { root: { id: 0, name: "(empty)", children: [] } });
      }
      // GET /v1/api/events
      if (path === "/v1/api/events" && request.method === "GET") {
        const runId = url.searchParams.get("runId") ?? "";
        const nodeId = url.searchParams.get("nodeId");
        const afterSeq = Number(url.searchParams.get("afterSeq") ?? "-1");
        const limit = Number(url.searchParams.get("limit") ?? "100");
        const rows = (state.events[runId] ?? [])
          .filter((row) => !nodeId || (row.payload as { nodeId?: string } | undefined)?.nodeId === nodeId)
          .filter((row) => Number(row.seq) > afterSeq)
          .sort((left, right) => Number(left.seq) - Number(right.seq));
        return ok(rows.slice(Math.max(0, rows.length - limit)));
      }
      // GET /v1/api/nodes/:runId/:nodeId/output
      const outMatch = path.match(/^\/v1\/api\/nodes\/([^/]+)\/([^/]+)\/output$/);
      if (outMatch && request.method === "GET") {
        const runId = decodeURIComponent(outMatch[1]!);
        const nodeId = decodeURIComponent(outMatch[2]!);
        const outputKey = `${runId}:${nodeId}`;
        const delayMs = state.outputDelayMs[outputKey] ?? 0;
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        return ok(state.outputs[outputKey] ?? null);
      }
      // GET /v1/api/approvals
      if (path === "/v1/api/approvals" && request.method === "GET") {
        return ok(state.approvals);
      }
      // POST /v1/api/approvals/:id (submitApproval)
      if (path.startsWith("/v1/api/approvals/") && request.method === "POST") {
        if (state.failApprovalSubmit) {
          return fail(500, "BOOM", "Forced failure for approval submit");
        }
        if (state.deferApprovalSubmit) {
          await new Promise<void>((resolve) => state.approvalSubmitWaiters.push(resolve));
        }
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        gateway.approvalsSubmitted.push(body);
        state.approvals = state.approvals.filter(
          (row) => `${row.runId}:${row.nodeId}:${row.iteration}` !== `${body.runId}:${body.nodeId}:${body.iteration}`,
        );
        const emitted = broadcast(["approvals"]);
        return ok({ ok: true }, { seq: emitted });
      }
      // GET /v1/api/workflows
      if (path === "/v1/api/workflows" && request.method === "GET") {
        return ok(state.workflows);
      }

      return fail(404, "NOT_FOUND", `No route for ${request.method} ${path}`);
    },
  });

  const gateway: InMemoryGateway = {
    baseUrl: `http://127.0.0.1:${server.port}`,
    get seq() {
      return seq;
    },
    state,
    launches: [],
    approvalsSubmitted: [],
    rewinds: [],
    pushEvents(runId, rows) {
      state.events[runId] = [...(state.events[runId] ?? []), ...rows];
      broadcast(["events"]);
    },
    releaseApprovalSubmits() {
      state.deferApprovalSubmit = false;
      for (const release of state.approvalSubmitWaiters.splice(0)) release();
    },
    async close() {
      for (const controller of controllers) {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
      controllers.clear();
      await server.stop(true);
    },
  };
  return gateway;
}
