import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { deriveRunState } from "@smithers-orchestrator/db/runState/deriveRunState";
import type { RunRow } from "@smithers-orchestrator/db/adapter/RunRow";
import type { RunState } from "@smithers-orchestrator/db/runState/RunState";
import type { RunStateView } from "@smithers-orchestrator/db/runState/RunStateView";
import { skewClock } from "../harness/skewClock.ts";

const STALE_THRESHOLD_MS = 30_000;

const ALLOWED_STATES: ReadonlySet<RunState> = new Set<RunState>([
  "running",
  "waiting-approval",
  "waiting-event",
  "waiting-timer",
  "recovering",
  "stale",
  "orphaned",
  "failed",
  "cancelled",
  "succeeded",
  "unknown",
]);

type Scenario = {
  label: string;
  build: (now: number) => RunRow;
  pendingApproval?: { nodeId: string; requestedAtMs: number } | null;
  pendingTimer?: { nodeId: string; firesAtMs: number } | null;
  pendingEvent?: { nodeId: string; correlationKey: string } | null;
  nowOverride?: (now: number) => number;
};

function baseRow(now: number, overrides: Partial<RunRow> = {}): RunRow {
  return {
    runId: "case08-run",
    parentRunId: null,
    workflowName: "case08-workflow",
    workflowPath: null,
    workflowHash: null,
    status: "running",
    createdAtMs: now - 60_000,
    startedAtMs: now - 50_000,
    finishedAtMs: null,
    heartbeatAtMs: now - 1_000,
    runtimeOwnerId: "engine:case08",
    cancelRequestedAtMs: null,
    hijackRequestedAtMs: null,
    hijackTarget: null,
    vcsType: null,
    vcsRoot: null,
    vcsRevision: null,
    errorJson: null,
    configJson: null,
    ...overrides,
  };
}

function buildDb(): Database {
  const sqlite = new Database(":memory:");
  ensureSmithersTables(drizzle(sqlite));
  return sqlite;
}

function persistAndRead(db: Database, row: RunRow): RunRow {
  db.query(
    `INSERT OR REPLACE INTO _smithers_runs
       (run_id, workflow_name, status, created_at_ms, started_at_ms,
        finished_at_ms, heartbeat_at_ms, runtime_owner_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.runId,
    row.workflowName,
    row.status,
    row.createdAtMs,
    row.startedAtMs,
    row.finishedAtMs,
    row.heartbeatAtMs,
    row.runtimeOwnerId,
  );
  const raw = db
    .query(
      `SELECT run_id, workflow_name, status, created_at_ms, started_at_ms,
              finished_at_ms, heartbeat_at_ms, runtime_owner_id
         FROM _smithers_runs WHERE run_id = ?`,
    )
    .get(row.runId) as {
    run_id: string;
    workflow_name: string;
    status: string;
    created_at_ms: number;
    started_at_ms: number | null;
    finished_at_ms: number | null;
    heartbeat_at_ms: number | null;
    runtime_owner_id: string | null;
  };
  return {
    ...row,
    runId: raw.run_id,
    workflowName: raw.workflow_name,
    status: raw.status,
    createdAtMs: raw.created_at_ms,
    startedAtMs: raw.started_at_ms,
    finishedAtMs: raw.finished_at_ms,
    heartbeatAtMs: raw.heartbeat_at_ms,
    runtimeOwnerId: raw.runtime_owner_id,
  };
}

function isIdleLike(state: string): boolean {
  const lowered = state.toLowerCase();
  return lowered === "idle" || lowered === "" || lowered === "unspecified";
}

function assertNotIdle(view: RunStateView, scenario: string): void {
  expect(view.state, `${scenario} produced idle-like state`).not.toBe(
    "idle" as unknown as RunState,
  );
  expect(isIdleLike(view.state), `${scenario} produced idle-like state`).toBe(
    false,
  );
  expect(
    ALLOWED_STATES.has(view.state),
    `${scenario} produced state outside allowed enum: ${view.state}`,
  ).toBe(true);
}

const SCENARIOS: Scenario[] = [
  {
    label: "running fresh heartbeat",
    build: (now) => baseRow(now, { heartbeatAtMs: now - 500 }),
  },
  {
    label: "running heartbeat exactly at staleness boundary",
    build: (now) =>
      baseRow(now, { heartbeatAtMs: now - STALE_THRESHOLD_MS }),
  },
  {
    label: "running heartbeat one ms past boundary",
    build: (now) =>
      baseRow(now, { heartbeatAtMs: now - STALE_THRESHOLD_MS - 1 }),
  },
  {
    label: "running null heartbeat with recent startedAt",
    build: (now) =>
      baseRow(now, { heartbeatAtMs: null, startedAtMs: now - 1_000 }),
  },
  {
    label: "running null heartbeat with stale startedAt + owner",
    build: (now) =>
      baseRow(now, {
        heartbeatAtMs: null,
        startedAtMs: now - 10 * STALE_THRESHOLD_MS,
      }),
  },
  {
    label: "running null heartbeat with stale startedAt + no owner (orphan)",
    build: (now) =>
      baseRow(now, {
        heartbeatAtMs: null,
        startedAtMs: now - 10 * STALE_THRESHOLD_MS,
        runtimeOwnerId: null,
      }),
  },
  {
    label: "running future heartbeat (clock skew corrupt)",
    build: (now) => baseRow(now, { heartbeatAtMs: now + 60_000 }),
  },
  {
    label: "running with both heartbeat and startedAt null",
    build: (now) => baseRow(now, { heartbeatAtMs: null, startedAtMs: null }),
  },
  {
    label: "running stale + owner present",
    build: (now) =>
      baseRow(now, {
        heartbeatAtMs: now - 10 * STALE_THRESHOLD_MS,
        runtimeOwnerId: "engine:dead",
      }),
  },
  {
    label: "running stale + owner empty string (orphan)",
    build: (now) =>
      baseRow(now, {
        heartbeatAtMs: now - 10 * STALE_THRESHOLD_MS,
        runtimeOwnerId: "",
      }),
  },
  {
    label: "waiting-approval with pending row",
    build: (now) => baseRow(now, { status: "waiting-approval" }),
    pendingApproval: { nodeId: "approve-deploy", requestedAtMs: 1 },
  },
  {
    label: "waiting-approval without pending row",
    build: (now) => baseRow(now, { status: "waiting-approval" }),
    pendingApproval: null,
  },
  {
    label: "waiting-event with correlation",
    build: (now) => baseRow(now, { status: "waiting-event" }),
    pendingEvent: { nodeId: "wait-webhook", correlationKey: "k1" },
  },
  {
    label: "waiting-event without correlation",
    build: (now) => baseRow(now, { status: "waiting-event" }),
    pendingEvent: null,
  },
  {
    label: "waiting-timer with firesAt",
    build: (now) => baseRow(now, { status: "waiting-timer" }),
    pendingTimer: { nodeId: "sleep", firesAtMs: 999 },
  },
  {
    label: "waiting-timer without firesAt",
    build: (now) => baseRow(now, { status: "waiting-timer" }),
    pendingTimer: null,
  },
  {
    label: "finished -> succeeded",
    build: (now) => baseRow(now, { status: "finished", finishedAtMs: now }),
  },
  {
    label: "continued -> succeeded",
    build: (now) => baseRow(now, { status: "continued", finishedAtMs: now }),
  },
  {
    label: "failed",
    build: (now) =>
      baseRow(now, { status: "failed", errorJson: '{"message":"boom"}' }),
  },
  {
    label: "cancelled",
    build: (now) =>
      baseRow(now, {
        status: "cancelled",
        cancelRequestedAtMs: now - 1_000,
      }),
  },
  {
    label: "unknown status string",
    build: (now) => baseRow(now, { status: "totally-bogus-status" }),
  },
  {
    label: "empty status string",
    build: (now) => baseRow(now, { status: "" }),
  },
];

describe("case 08: inspector never shows idle", () => {
  test("structural: allowed-states enum has no idle entry", () => {
    expect(ALLOWED_STATES.has("idle" as unknown as RunState)).toBe(false);
    for (const state of ALLOWED_STATES) {
      expect(isIdleLike(state)).toBe(false);
    }
    expect(ALLOWED_STATES.size).toBe(11);
  });

  test("semantic: every seeded scenario maps to a non-idle allowed state", () => {
    const db = buildDb();
    const observed = new Set<string>();
    try {
      const now = Date.now();
      for (const scenario of SCENARIOS) {
        const row = persistAndRead(db, scenario.build(now));
        const view = deriveRunState({
          run: row,
          pendingApproval: scenario.pendingApproval ?? null,
          pendingTimer: scenario.pendingTimer ?? null,
          pendingEvent: scenario.pendingEvent ?? null,
          now,
          staleThresholdMs: STALE_THRESHOLD_MS,
        });
        assertNotIdle(view, scenario.label);
        observed.add(view.state);
      }

      expect(observed.has("idle")).toBe(false);
      expect(observed.has("running")).toBe(true);
      expect(observed.has("waiting-approval")).toBe(true);
      expect(observed.has("waiting-event")).toBe(true);
      expect(observed.has("waiting-timer")).toBe(true);
      expect(observed.has("stale")).toBe(true);
      expect(observed.has("orphaned")).toBe(true);
      expect(observed.has("succeeded")).toBe(true);
      expect(observed.has("failed")).toBe(true);
      expect(observed.has("cancelled")).toBe(true);
      expect(observed.has("unknown")).toBe(true);
      for (const state of observed) {
        expect(ALLOWED_STATES.has(state as RunState)).toBe(true);
      }
    } finally {
      db.close();
    }
  });

  test("active run with frequent tool-call bursts never idles across the staleness boundary", () => {
    const db = buildDb();
    const clock = skewClock(0);
    try {
      const t0 = clock.now();
      let row = persistAndRead(
        db,
        baseRow(t0, { heartbeatAtMs: t0, startedAtMs: t0 - 1_000 }),
      );

      const offsets = [
        0,
        1,
        STALE_THRESHOLD_MS - 1,
        STALE_THRESHOLD_MS,
        STALE_THRESHOLD_MS + 1,
        2 * STALE_THRESHOLD_MS,
        5 * STALE_THRESHOLD_MS,
      ];

      for (const offset of offsets) {
        clock.advance(offset > 0 ? offset - (clock.now() - t0) : 0);
        const view = deriveRunState({
          run: row,
          now: clock.now(),
          staleThresholdMs: STALE_THRESHOLD_MS,
        });
        assertNotIdle(view, `tool-call burst @ +${offset}ms`);

        const beat = clock.now();
        row = persistAndRead(db, { ...row, heartbeatAtMs: beat });
        const afterBeat = deriveRunState({
          run: row,
          now: beat,
          staleThresholdMs: STALE_THRESHOLD_MS,
        });
        assertNotIdle(afterBeat, `post-heartbeat @ +${offset}ms`);
        expect(afterBeat.state).toBe("running");
      }
    } finally {
      clock.restore();
      db.close();
    }
  });

  test("future-heartbeat (corrupt clock) and concurrent burst still avoid idle", () => {
    const db = buildDb();
    const clock = skewClock(0);
    try {
      const now = clock.now();
      const cases: Array<Pick<RunRow, "heartbeatAtMs" | "startedAtMs">> = [
        { heartbeatAtMs: now + 1_000, startedAtMs: now - 5_000 },
        { heartbeatAtMs: now + 60_000, startedAtMs: now - 5_000 },
        { heartbeatAtMs: now + 60_000, startedAtMs: null },
        { heartbeatAtMs: null, startedAtMs: now + 1_000 },
      ];
      for (const patch of cases) {
        const row = persistAndRead(db, baseRow(now, patch));
        const view = deriveRunState({
          run: row,
          now,
          staleThresholdMs: STALE_THRESHOLD_MS,
        });
        assertNotIdle(
          view,
          `corrupt-clock heartbeat=${patch.heartbeatAtMs} started=${patch.startedAtMs}`,
        );
        expect(view.state).toBe("running");
      }
    } finally {
      clock.restore();
      db.close();
    }
  });

  test("regression guard catches a synthetic idle leak", () => {
    const db = buildDb();
    try {
      const now = Date.now();
      const row = persistAndRead(db, baseRow(now));
      const view = deriveRunState({
        run: row,
        now,
        staleThresholdMs: STALE_THRESHOLD_MS,
      });
      const leaked: RunStateView = {
        ...view,
        state: "idle" as unknown as RunState,
      };
      expect(() => assertNotIdle(leaked, "synthetic-leak")).toThrow();

      const blank: RunStateView = {
        ...view,
        state: "" as unknown as RunState,
      };
      expect(() => assertNotIdle(blank, "synthetic-blank")).toThrow();

      const bogus: RunStateView = {
        ...view,
        state: "stalled" as unknown as RunState,
      };
      expect(() => assertNotIdle(bogus, "synthetic-bogus")).toThrow();
    } finally {
      db.close();
    }
  });
});
