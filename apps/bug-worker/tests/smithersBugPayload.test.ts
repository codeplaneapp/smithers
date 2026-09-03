import { ControlSchema } from "@smthrs/control";
import { Schema } from "effect";
import { describe, expect, test } from "bun:test";
import { bugReportSchema } from "../src/bugReportSchema.ts";
import type { BugWorkerEnv } from "../src/worker.ts";
import { createBugWorker } from "../src/worker.ts";
import { memoryKv } from "./helpers/memoryKv.ts";

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

const payload = {
  summary: "the review step exhausted its correction budget",
  version: "1.0.0-rc.0",
  platform: "darwin-arm64",
  node: "22.19.0",
  runs: [runSummary],
  digest: { runId: runSummary.runId, events: controlEvents },
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
  test("accepts and stores the CLI payload", async () => {
    expect(bugReportSchema.safeParse(payload).success).toBe(true);
    const env = makeEnv();
    const response = await createBugWorker().fetch(post(payload), env);
    expect(response.status).toBe(201);

    const { id } = (await response.json()) as { id: string };
    const record = JSON.parse((await env.BUGS.get(`bug:${id}`))!) as { report: typeof payload };
    expect(record.report.summary).toBe(payload.summary);
    expect(record.report.runs[0]?.flowId).toBe("flows/build-and-review");
    expect(record.report.digest.events).toHaveLength(3);
  });

  test("stores every current run status", async () => {
    const env = makeEnv();
    for (const status of ControlSchema.RunStatus.literals) {
      const response = await createBugWorker().fetch(post({ ...payload, runs: [{ ...runSummary, status }] }), env);
      expect(response.status).toBe(201);
    }
  });

  test("accepts a report without a run digest", async () => {
    const response = await createBugWorker().fetch(
      post({ summary: "init wrote no flow", version: "1.0.0-rc.0", platform: "linux-x64", node: "22.19.0", runs: [] }),
      makeEnv(),
    );
    expect(response.status).toBe(201);
  });

  test("requires a non-empty summary", () => {
    expect(bugReportSchema.safeParse({ version: "1.0.0-rc.0", runs: [] }).success).toBe(false);
    expect(bugReportSchema.safeParse({ summary: "" }).success).toBe(false);
  });
});
