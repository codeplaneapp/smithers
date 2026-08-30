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
 * Run blocks here are built from `@smthrs/control`'s own DTOs rather than typed
 * out by hand, so a change to `RunSummary` or `ControlEvent` fails here instead
 * of quietly producing reports the worker stores but nobody can read. The
 * worker's schema is loose past the headline, so a wrong shape would otherwise
 * be accepted and only noticed in triage.
 *
 * Two client shapes reach this endpoint and both must keep working. The rc.0
 * `bug` verb (`packages/cli/src/Command.ts`, cli-ops lane) posts `summary`, a
 * `platform` string, `node`, `runs` and an optional `digest`. 0.x posted
 * `title`, `body`, `smithersVersion`, a `platform` object and a singular `run`
 * whose events were keyed `seq`/`timestampMs`/`type` over a five-status
 * vocabulary; rc.0 run DTOs use `flowId`, seven statuses, and
 * `sequence`/`occurredAt`/`kind`.
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

/**
 * A hand-composed report carrying rc.0 run DTOs under the 0.x envelope.
 *
 * This is the shape a human or an old client sends, not what the rc.0 verb
 * builds — that one is asserted separately below, against the verb's own
 * fields. Both have to be accepted.
 */
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
  test("the intake schema accepts a 0.x envelope carrying rc.0 run DTOs", () => {
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

  test("the payload the rc.0 `smithers bug` verb actually posts is accepted", async () => {
    // The shape below is what `packages/cli/src/Command.ts` builds through
    // `Bug.report` and POSTs to `Bug.defaultEndpoint`
    // (https://bug.smithers.sh/api/bugs, this worker): a `summary` line, a
    // `platform` STRING, `node`, the `runs` array from `Control.list`, and an
    // optional `digest` when `--run` names one. There is no `title`, no `body`,
    // no `smithersVersion`, and no singular `run`.
    //
    // The verb is the cli-ops lane's; this test owns the receiving half. The
    // run entries are decoded through `@smthrs/control`'s RunSummary so the
    // fixture cannot drift from the DTO the verb lists.
    const env = makeEnv();
    const rcPayload = {
      summary: "the review step exhausted its correction budget",
      version: "1.0.0-rc.0",
      platform: "darwin-arm64",
      node: "22.19.0",
      runs: [runSummary],
      digest: { runId: runSummary.runId, events: controlEvents },
    };

    const response = await createBugWorker().fetch(post(rcPayload), env);
    expect(response.status).toBe(201);

    const { id } = (await response.json()) as { id: string };
    const record = JSON.parse((await env.BUGS.get(`bug:${id}`))!) as {
      report: Record<string, unknown>;
    };
    // Stored whole: triage reads the summary, the runs, and the digest.
    expect(record.report.summary).toBe("the review step exhausted its correction budget");
    expect(record.report.platform).toBe("darwin-arm64");
    expect((record.report.runs as unknown[])).toHaveLength(1);
    expect(record.report.digest).toBeDefined();
  });

  test("the verb's report survives with only a summary, as `smithers bug` sends with no --run", async () => {
    // `digest` is omitted entirely unless --run names a run, and `runs` is the
    // empty array on a project with no runs yet. Requiring either would bounce
    // the first report a new user ever files.
    const response = await createBugWorker().fetch(
      post({ summary: "init wrote no flow", version: "1.0.0-rc.0", platform: "linux-x64", node: "22.19.0", runs: [] }),
      makeEnv(),
    );
    expect(response.status).toBe(201);
  });

  test("a report with neither a title nor a summary is refused", () => {
    // The headline is the one field triage cannot work without, and accepting
    // both spellings must not degrade into accepting none.
    expect(bugReportSchema.safeParse({ version: "1.0.0-rc.0", runs: [] }).success).toBe(false);
    expect(bugReportSchema.safeParse({ title: "", summary: "" }).success).toBe(false);
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
