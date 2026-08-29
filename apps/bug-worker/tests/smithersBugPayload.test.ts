import { describe, expect, test } from "bun:test";
import { ControlSchema } from "@smthrs/control";
import { Schema } from "effect";
import { bugReportSchema } from "../src/bugReportSchema.ts";
import type { BugWorkerEnv } from "../src/worker.ts";
import { createBugWorker } from "../src/worker.ts";
import { memoryKv } from "./helpers/memoryKv.ts";

/**
 * The contract between `smithers bug` and this worker.
 *
 * The run block is built from `@smthrs/control`'s own DTOs rather than typed
 * out by hand, so a change to `RunSummary` or `ControlEvent` fails here instead
 * of quietly producing reports the worker stores but nobody can read. That is
 * the whole point of pinning it: the worker's schema is loose past `title`, so
 * a wrong shape would be accepted and only noticed in triage.
 *
 * 0.x sent `workflowName`, `workflowPath`, a five-status vocabulary, and events
 * keyed `seq`/`timestampMs`/`type`. rc.0 sends `flowId`, the seven-status
 * vocabulary, and events keyed `sequence`/`occurredAt`/`kind`.
 */
const decodeRunSummary = Schema.decodeUnknownSync(ControlSchema.RunSummary);
const decodeControlEvent = Schema.decodeUnknownSync(ControlSchema.ControlEvent);

const runSummary = decodeRunSummary({
  runId: "run-01JQ8Z2K3M4N5P6Q7R8S9T0V1W",
  flowId: "flows/build-and-review",
  status: "failed",
  planId: "plan-7f3c",
  planDigest: "sha256:0e1d",
  createdAt: 1_788_000_000_000,
  updatedAt: 1_788_000_042_000,
});

const controlEvents = [
  { sequence: 1, kind: "control.run.accepted", runId: runSummary.runId, occurredAt: 1_788_000_000_100, payload: {} },
  {
    sequence: 2,
    kind: "control.approval.requested",
    runId: runSummary.runId,
    occurredAt: 1_788_000_010_000,
    payload: { target: { _tag: "Node", nodeId: "review" } },
  },
  {
    sequence: 3,
    kind: "control.run.failed",
    runId: runSummary.runId,
    occurredAt: 1_788_000_042_000,
    payload: { message: "the review step exhausted its correction budget" },
  },
].map((event) => decodeControlEvent(event));

/** The payload the `bug` verb posts: platform, version, and the run digest. */
const payload = {
  title: `Run ${runSummary.runId} failed: the review step exhausted its correction budget`,
  body: "It failed the same way twice on a clean checkout.",
  smithersVersion: "1.0.0-rc.0",
  platform: { os: "darwin", arch: "arm64", nodeVersion: "v22.19.0" },
  createdAtMs: 1_788_000_050_000,
  run: {
    runId: runSummary.runId,
    flowId: runSummary.flowId,
    status: runSummary.status,
    createdAt: runSummary.createdAt,
    updatedAt: runSummary.updatedAt,
    error: "the review step exhausted its correction budget",
    events: controlEvents,
  },
};

function makeEnv(): BugWorkerEnv & { BUGS: ReturnType<typeof memoryKv> } {
  return { BUGS: memoryKv(), BUG_ADMIN_TOKEN: "admin", PUBLIC_BASE_URL: "https://bug.smithers.sh" };
}

function post(body: unknown): Request {
  return new Request("https://bug.smithers.sh/api/bugs", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" },
    body: JSON.stringify(body),
  });
}

describe("the smithers bug payload contract", () => {
  test("the intake schema accepts an rc.0 report", () => {
    const parsed = bugReportSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
  });

  test("the worker stores it whole, run digest included", async () => {
    const env = makeEnv();
    const response = await createBugWorker().fetch(post(payload), env);
    expect(response.status).toBe(201);

    const { id } = (await response.json()) as { id: string };
    const record = JSON.parse((await env.BUGS.get(`bug:${id}`))!) as {
      report: typeof payload;
    };
    // The run digest survives intact: a triage reader needs the flow, the
    // status, and the event tail, and KV stores whatever the schema let past.
    expect(record.report.run.flowId).toBe("flows/build-and-review");
    expect(record.report.run.status).toBe("failed");
    expect(record.report.run.events).toHaveLength(3);
    expect(record.report.run.events[2].kind).toBe("control.run.failed");
    expect(record.report.smithersVersion).toBe("1.0.0-rc.0");
  });

  test("every rc.0 run status is a status the worker will store", async () => {
    const env = makeEnv();
    for (const status of ControlSchema.RunStatus.literals) {
      const response = await createBugWorker().fetch(
        post({ ...payload, run: { ...payload.run, status } }),
        env,
      );
      expect(response.status).toBe(201);
    }
  });

  test("a report with no run at all is still accepted", async () => {
    // `smithers bug --title ...` with no --run sends the run key as null.
    const response = await createBugWorker().fetch(
      post({ title: "docs typo", body: "", smithersVersion: "1.0.0-rc.0", run: null }),
      makeEnv(),
    );
    expect(response.status).toBe(201);
  });

  test("a 0.x-shaped report is still stored, so an old CLI never loses a report", async () => {
    // The worker is deployed once and talks to every CLI version ever
    // installed. Bouncing an old shape would drop the report of the user most
    // likely to be hitting a bug.
    const response = await createBugWorker().fetch(
      post({
        title: "engine crashed on resume",
        smithersVersion: "0.35.0",
        run: {
          runId: "r-123",
          workflowName: "build-and-review",
          workflowPath: ".smithers/workflows/build.tsx",
          status: "failed",
          events: [{ seq: 1, timestampMs: 1, type: "TaskStarted", payload: {} }],
        },
      }),
      makeEnv(),
    );
    expect(response.status).toBe(201);
  });
});
