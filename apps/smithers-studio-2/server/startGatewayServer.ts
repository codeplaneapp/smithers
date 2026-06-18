import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createSmithers, Gateway, SmithersDb } from "smithers-orchestrator";
import { jsx } from "smithers-orchestrator/jsx-runtime";

/**
 * Boot the REAL Smithers Gateway for the studio dev stack.
 *
 * Entry point invoked by `scripts/dev.ts` (and runnable standalone). Binds to
 * `SMITHERS_STUDIO_GATEWAY_PORT` (default 7331) on 127.0.0.1 and serves the real
 * Gateway HTTP surface: `/health`, the JSON-RPC endpoint at `/rpc` + `/v1/rpc/*`,
 * and the workflow-UI mounts. It is the production-shaped sibling of
 * `server/startWorkspaceApiServer.ts`.
 *
 * IT SEEDS NOTHING. Unlike the e2e fixture (`tests/fixtures/gatewayFixture.tsx`,
 * which inline-defines demo workflows and executes seeded `studio-*` runs so the
 * Playwright specs have deterministic trees + gates), this server binds a single
 * Gateway adapter directly to the workspace database and surfaces whatever REAL
 * runs already live there. `listRuns` reads `_smithers_runs` DB-wide, so every
 * real run recorded by `smithers up` / the workflows in this workspace shows up
 * with its own `workflowName`/`workflowPath` — no demo rows, no execution on boot.
 *
 * LIVE EVENTS for out-of-process runs (the event bridge below). Runs launched by
 * the studio's Workflows form go out-of-process via `smithers up --detach`, so
 * their per-node events are NOT delivered to this gateway's in-process event
 * pump (`handleSmithersEvent`, fed only when the gateway itself executes a run).
 * Without help the gateway's run-event window stays empty for those runs and
 * `streamRunEvents` delivers only `run.heartbeat` frames. But the engine ALSO
 * persists every event to `_smithers_events` (one row per `CorrelatedSmithersEvent`,
 * `payload_json` = the exact object `handleSmithersEvent` consumes). The bridge
 * tails that table for non-terminal runs the gateway is NOT executing in-process
 * and feeds each new persisted event through `handleSmithersEvent`, which maps +
 * broadcasts it exactly like an in-process event — so `streamRunEvents` delivers
 * REAL per-node frames for detached runs too. This is a thin wire-up of existing
 * machinery: no new schema, no new transport, no execution on boot.
 *
 * Why a single workspace-scoped adapter (and not one register() per discovered
 * `.smithers/workflows/*.tsx`):
 *   - Every discovered workflow defaults to the SAME `./smithers.db`
 *     (`createSmithers`'s default `dbPath`), so the Gateway's
 *     `listRunsAcrossWorkflows` — which iterates one adapter per registered key
 *     and concatenates each adapter's full `listRuns` — would surface every run
 *     once per registered workflow (N registrations over one DB ⇒ N× duplicate
 *     run rows). One adapter over the workspace DB lists each real run exactly
 *     once.
 *   - Importing the real workflow modules requires `process.chdir(workspace)` so
 *     their cwd-relative `./smithers.db` resolves to the workspace DB. Under Bun,
 *     resolving the workspace root's module graph (the orchestrator's JSX runtime
 *     plus the hundreds of per-worktree React copies under
 *     `.smithers/workflows/.worktrees/*`) corrupts Bun's module resolver
 *     (`EISDIR ... react@.../index.js` with garbled cache paths) and aborts boot.
 *     Binding the adapter to an ABSOLUTE workspace DB path keeps the gateway
 *     bootable from the studio app dir while still reading the real workspace DB.
 *
 * The Gateway runs under Bun (the orchestrator's SQLite layer uses `bun:sqlite`);
 * vite proxies `/rpc` + `/v1/rpc` to this process so the browser reaches it
 * same-origin.
 *
 * Env:
 *   SMITHERS_STUDIO_GATEWAY_PORT — port to listen on (default 7331).
 *   SMITHERS_STUDIO_GATEWAY_HOST — host to bind (default 127.0.0.1).
 *   SMITHERS_STUDIO_WORKSPACE    — workspace dir holding the real .smithers +
 *                                  smithers.db (default: process cwd).
 */
const port = Number(process.env.SMITHERS_STUDIO_GATEWAY_PORT ?? "7331");
const host = process.env.SMITHERS_STUDIO_GATEWAY_HOST ?? "127.0.0.1";
const workspace = resolve(process.env.SMITHERS_STUDIO_WORKSPACE ?? process.cwd());

const dbPath = resolve(workspace, "smithers.db");
if (!existsSync(dbPath)) {
  throw new Error(
    `No workspace database at ${dbPath}. Run a workflow (e.g. \`smithers up\`) in ${workspace} first, ` +
      `or set SMITHERS_STUDIO_WORKSPACE to a workspace that has a real .smithers + smithers.db.`,
  );
}

// A single, schemaless workflow whose adapter is bound to the REAL workspace DB.
// It registers no tasks and is never executed here — its only job is to give the
// Gateway one adapter over `smithers.db` so `listRuns`/snapshots/approvals serve
// the workspace's real runs. The explicit absolute `dbPath` makes the binding
// independent of `process.cwd()`. The Workflow element is built via the
// orchestrator's JSX runtime (`jsx(...)`) so this entry stays a plain `.ts` file.
const { smithers, Workflow } = createSmithers({}, { dbPath });
const workspaceWorkflow = smithers(() => jsx(Workflow, { name: "workspace" }));

// `workspaceRoot` makes disk-backed registry reads (the `listPrompts` RPC, which
// walks `<workspaceRoot>/.smithers/prompts/`) resolve from the REAL workspace —
// not this app's `process.cwd()`. This server intentionally keeps its cwd in the
// studio app and binds the adapter to an ABSOLUTE workspace DB path (see the
// header note above), so without this the gateway would walk the wrong app's
// prompts (or none). `workspace` is the same root the DB path is derived from.
const gateway = new Gateway({ heartbeatMs: 15_000, workspaceRoot: workspace });
gateway.register("workspace", workspaceWorkflow);

await gateway.listen({ port, host });
process.stdout.write(`studio-2 gateway server listening on http://${host}:${port} (workspace ${workspace})\n`);

const stopEventBridge = startOutOfProcessEventBridge(gateway, workspaceWorkflow);

/**
 * Bridge persisted `_smithers_events` rows into the gateway's live run-event
 * stream for runs the gateway is NOT executing in-process.
 *
 * Why this exists: a detached run (`smithers up --detach`, what the studio's
 * Workflows form launches) runs in a SEPARATE process. Its events never reach
 * this gateway's in-process pump (`handleSmithersEvent`, called only from the
 * gateway's own `onProgress` when it executes a run), so the gateway's run-event
 * window is empty for that run and `streamRunEvents` delivers only heartbeats —
 * the logs tab stays blank even though the run is genuinely producing output.
 *
 * The engine persists every event to `_smithers_events` as one row per
 * `CorrelatedSmithersEvent` (`payload_json` = `JSON.stringify(event)`, the exact
 * object `handleSmithersEvent` consumes; `type` = the event type). This poller
 * tails that table for each active run and replays each new row through
 * `handleSmithersEvent`, which maps + broadcasts it identically to an in-process
 * event. The result: real per-node frames (`node.started`, `task.output`,
 * `approval.requested`, `run.completed`, …) flow to subscribed `streamRunEvents`
 * clients for out-of-process runs, same as in-process ones.
 *
 * Correctness / safety:
 *   - Runs the gateway IS executing in-process (present in its `runRegistry`) are
 *     SKIPPED — those already feed `handleSmithersEvent` via `onProgress`, and
 *     replaying their persisted copies would double-emit. (The dev gateway never
 *     launches runs, so its registry is normally empty; the guard keeps the
 *     bridge correct regardless.)
 *   - Per-run `lastFedSeq` cursor (the persisted, per-run, monotonic
 *     `_smithers_events.seq`) guarantees each event is fed at most once.
 *   - Terminal runs (finished/failed/cancelled) get one final drain to flush any
 *     tail events, then are dropped from the cursor map so they stop being polled.
 */
function startOutOfProcessEventBridge(
  // The gateway instance exposes `runRegistry` (in-process runs) and
  // `handleSmithersEvent` (the event ingestion path) as members usable from this
  // same-process boot script. They are typed loosely here because they are not
  // part of the public Gateway type surface.
  gatewayInstance: Gateway & {
    runRegistry?: Map<string, unknown>;
    handleSmithersEvent?: (event: unknown) => void;
  },
  workflow: { db: ConstructorParameters<typeof SmithersDb>[0] },
): () => void {
  const POLL_MS = 1_000;
  const PAGE_LIMIT = 500;
  // A run stops emitting events under its runId once it reaches any of these.
  // `continued` (continue-as-new) is included: the engine marks the old runId
  // `continued` and resumes under a FRESH runId, so the old one should be
  // drained once and then ignored — otherwise the poller queries it forever.
  const TERMINAL = new Set(["finished", "failed", "cancelled", "continued"]);
  const adapter = new SmithersDb(workflow.db);
  // runId -> highest persisted seq we have already fed to the gateway.
  const lastFedSeq = new Map<string, number>();
  // runIds we have already drained after they reached a terminal state.
  const drained = new Set<string>();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const feedRun = async (runId: string, terminal: boolean): Promise<void> => {
    // Never replay events for a run the gateway executes itself — it already
    // pumps those through handleSmithersEvent via onProgress.
    if (gatewayInstance.runRegistry?.has(runId)) return;
    let afterSeq = lastFedSeq.get(runId) ?? -1;
    // A terminal run is drained FULLY here: loop until a short page so its
    // entire tail reaches the gateway even if it is more than PAGE_LIMIT events
    // behind the persisted head (verbose detached runs easily exceed 500, and a
    // run first seen already-terminal starts from seq -1). An active run feeds
    // one page per tick and self-continues on the next tick, so it does not loop.
    for (;;) {
      const rows = (await adapter.listEventHistory(runId, {
        afterSeq,
        limit: PAGE_LIMIT,
      })) as Array<{ seq?: unknown; payloadJson?: unknown; payload_json?: unknown }>;
      let maxSeq = afterSeq;
      for (const row of rows) {
        const seq = typeof row.seq === "number" ? row.seq : Number(row.seq);
        if (Number.isFinite(seq) && seq > maxSeq) maxSeq = seq;
        // The adapter maps columns to camelCase (`payloadJson`); accept the raw
        // snake_case form too in case a different storage backend surfaces it.
        const payloadJson =
          typeof row.payloadJson === "string"
            ? row.payloadJson
            : typeof row.payload_json === "string"
              ? row.payload_json
              : undefined;
        if (!payloadJson) continue;
        let event: unknown;
        try {
          event = JSON.parse(payloadJson);
        } catch {
          // A malformed row should not stall the whole bridge.
          continue;
        }
        gatewayInstance.handleSmithersEvent?.(event);
      }
      const advanced = maxSeq > afterSeq;
      if (advanced) {
        afterSeq = maxSeq;
        lastFedSeq.set(runId, maxSeq);
      }
      // Keep draining a terminal run while pages are full and the cursor still
      // advances; `!advanced` guards against a stuck cursor (e.g. seq-less rows).
      if (!terminal || rows.length < PAGE_LIMIT || !advanced) break;
    }
    // After a terminal run's final drain, stop tracking it so the poller does
    // not keep querying a finished run forever.
    if (terminal) {
      drained.add(runId);
      lastFedSeq.delete(runId);
    }
  };

  const tick = async (): Promise<void> => {
    // Active runs cover everything still producing events; terminal runs are
    // drained once (to flush tail events) and then ignored.
    const runs = (await adapter.listRuns(1_000)) as Array<{ runId?: unknown; status?: unknown }>;
    const live = new Set<string>();
    for (const run of runs) {
      const runId = typeof run.runId === "string" ? run.runId : undefined;
      if (!runId) continue;
      live.add(runId);
      const status = typeof run.status === "string" ? run.status : "";
      const terminal = TERMINAL.has(status);
      if (terminal) {
        if (drained.has(runId)) continue;
        await feedRun(runId, true);
        continue;
      }
      await feedRun(runId, false);
    }
    // Prune cursors for runs no longer in the listing so neither map grows with
    // total historical run count over the gateway's lifetime.
    for (const id of [...drained]) if (!live.has(id)) drained.delete(id);
    for (const id of [...lastFedSeq.keys()]) if (!live.has(id)) lastFedSeq.delete(id);
  };

  const loop = (): void => {
    if (stopped) return;
    void tick()
      .catch(() => {
        // Best-effort: a transient DB read error must not kill the bridge or
        // the gateway. The next tick retries.
      })
      .finally(() => {
        if (!stopped) timer = setTimeout(loop, POLL_MS);
      });
  };
  loop();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

async function shutdown(): Promise<void> {
  stopEventBridge();
  try {
    await gateway.close();
  } catch {
    // best-effort close on shutdown
  }
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
