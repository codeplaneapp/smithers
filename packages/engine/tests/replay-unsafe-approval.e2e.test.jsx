/** @jsxImportSource smthrs */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { z } from "zod";
import { SmithersDb, Task, Workflow, defineTool, runWorkflow } from "smthrs";
import { approveNode, denyNode } from "../src/approvals.js";
import { createTestSmithers } from "../../smithers/tests/helpers.js";

const TIMEOUT_MS = 20_000;

function makeTool({ name, idempotent, keyed, invocations }) {
  const execute = keyed
    ? async (_args, ctx) => {
        invocations.push(ctx.idempotencyKey);
        return "ok";
      }
    : async () => {
        invocations.push(null);
        return "ok";
      };
  return defineTool({
    name,
    schema: z.object({}),
    sideEffect: true,
    idempotent,
    execute,
  });
}

function makeAgent(tool, name, failures = 1) {
  let failedGenerations = 0;
  return {
    id: `agent-${name}`,
    model: "deterministic-test-agent",
    tools: { [name]: tool },
    async generate() {
      await tool.execute({});
      if (failedGenerations < failures) {
        failedGenerations += 1;
        throw new Error("interrupt after side effect");
      }
      return { output: { value: 2 } };
    },
  };
}

function buildWorkflow(agent, name, retries = 1) {
  const fixture = createTestSmithers({ result: z.object({ value: z.number() }) });
  const workflow = fixture.smithers(() => (
    <Workflow name={`replay-${name}`}>
      <Task
        id="publish"
        output={fixture.outputs.result}
        agent={agent}
        retries={retries}
        retryPolicy={{ backoff: "fixed", initialDelayMs: 0 }}
      >
        Publish once.
      </Task>
    </Workflow>
  ));
  return { ...fixture, workflow };
}

describe("replay-unsafe approval through the real engine", () => {
  test(
    "parks a replay of an unkeyed non-idempotent tool before invoking it again",
    async () => {
      const invocations = [];
      const tool = makeTool({ name: "publish-comment", idempotent: false, keyed: false, invocations });
      const fixture = buildWorkflow(makeAgent(tool, "publish-comment"), "unsafe");
      try {
        const result = await Effect.runPromise(runWorkflow(fixture.workflow, { input: {} }));
        expect(result.status).toBe("waiting-approval");
        expect(invocations).toEqual([null]);

        const adapter = new SmithersDb(fixture.db);
        const approval = await Effect.runPromise(adapter.getApproval(result.runId, "publish", 0));
        expect(approval?.status).toBe("requested");
        expect(JSON.parse(approval?.requestJson ?? "{}")).toMatchObject({
          kind: "ReplayUnsafeApproval",
          offending: [{ toolName: "publish-comment", attempt: 1, seq: 1 }],
        });
        expect((await Effect.runPromise(adapter.getRun(result.runId)))?.status).toBe("waiting-approval");
        expect(await Effect.runPromise(adapter.listToolCalls(result.runId, "publish", 0))).toHaveLength(1);
      } finally {
        fixture.cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "consumes an approved replay request and preserves the approved row",
    async () => {
      const invocations = [];
      const tool = makeTool({ name: "approved-publish", idempotent: false, keyed: false, invocations });
      const fixture = buildWorkflow(makeAgent(tool, "approved-publish"), "approved");
      try {
        const first = await Effect.runPromise(runWorkflow(fixture.workflow, { input: {} }));
        expect(first.status).toBe("waiting-approval");
        const adapter = new SmithersDb(fixture.db);
        const requested = await Effect.runPromise(adapter.getApproval(first.runId, "publish", 0));
        const request = JSON.parse(requested?.requestJson ?? "{}");
        expect(request).toEqual(
          expect.objectContaining({
            kind: "ReplayUnsafeApproval",
            fingerprint: expect.any(String),
            authorizedAttempt: expect.any(Number),
          }),
        );

        await Effect.runPromise(approveNode(adapter, first.runId, "publish", 0, "retry once", "operator"));
        const resumed = await Effect.runPromise(
          runWorkflow(fixture.workflow, {
            input: {},
            runId: first.runId,
            resume: true,
          }),
        );

        expect(resumed.status).toBe("finished");
        expect(invocations).toEqual([null, null]);
        const approval = await Effect.runPromise(adapter.getApproval(first.runId, "publish", 0));
        expect(approval?.status).toBe("approved");
        expect(JSON.parse(approval?.decisionJson ?? "{}")).toEqual(
          expect.objectContaining({
            kind: "ReplayUnsafeApproval",
            approved: true,
            fingerprint: request.fingerprint,
            authorizedAttempt: request.authorizedAttempt,
          }),
        );
      } finally {
        fixture.cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "fails permanently when a replay request is denied",
    async () => {
      const invocations = [];
      const tool = makeTool({ name: "denied-publish", idempotent: false, keyed: false, invocations });
      const fixture = buildWorkflow(makeAgent(tool, "denied-publish"), "denied");
      try {
        const first = await Effect.runPromise(runWorkflow(fixture.workflow, { input: {} }));
        expect(first.status).toBe("waiting-approval");
        const adapter = new SmithersDb(fixture.db);
        const requested = await Effect.runPromise(adapter.getApproval(first.runId, "publish", 0));
        const request = JSON.parse(requested?.requestJson ?? "{}");

        await Effect.runPromise(denyNode(adapter, first.runId, "publish", 0, "do not retry", "operator"));
        const resumed = await Effect.runPromise(
          runWorkflow(fixture.workflow, {
            input: {},
            runId: first.runId,
            resume: true,
          }),
        );

        expect(resumed.status).toBe("failed");
        expect(invocations).toEqual([null]);
        const approval = await Effect.runPromise(adapter.getApproval(first.runId, "publish", 0));
        expect(approval?.status).toBe("denied");
        expect(JSON.parse(approval?.decisionJson ?? "{}")).toEqual(
          expect.objectContaining({
            kind: "ReplayUnsafeApproval",
            approved: false,
            fingerprint: request.fingerprint,
            authorizedAttempt: request.authorizedAttempt,
          }),
        );
        expect(await Effect.runPromise(adapter.listEventsByType(first.runId, "ApprovalRequested"))).toHaveLength(1);

        const resumedAgain = await Effect.runPromise(
          runWorkflow(fixture.workflow, {
            input: {},
            runId: first.runId,
            resume: true,
          }),
        );
        expect(resumedAgain.status).toBe("failed");
        expect((await Effect.runPromise(adapter.getApproval(first.runId, "publish", 0)))?.status).toBe("denied");
        expect(await Effect.runPromise(adapter.listEventsByType(first.runId, "ApprovalRequested"))).toHaveLength(1);
      } finally {
        fixture.cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "parks with a distinct request when a later failed attempt adds an unsafe call",
    async () => {
      const invocations = [];
      const tool = makeTool({ name: "repeat-publish", idempotent: false, keyed: false, invocations });
      const fixture = buildWorkflow(makeAgent(tool, "repeat-publish", 2), "repeat", 2);
      try {
        const first = await Effect.runPromise(runWorkflow(fixture.workflow, { input: {} }));
        expect(first.status).toBe("waiting-approval");
        const adapter = new SmithersDb(fixture.db);
        const firstApproval = await Effect.runPromise(adapter.getApproval(first.runId, "publish", 0));
        const firstRequest = JSON.parse(firstApproval?.requestJson ?? "{}");

        await Effect.runPromise(approveNode(adapter, first.runId, "publish", 0, "retry once", "operator"));
        const resumed = await Effect.runPromise(
          runWorkflow(fixture.workflow, {
            input: {},
            runId: first.runId,
            resume: true,
          }),
        );

        expect(resumed.status).toBe("waiting-approval");
        expect(invocations).toEqual([null, null]);
        const preserved = await Effect.runPromise(adapter.getApproval(first.runId, "publish", 0));
        expect(preserved?.status).toBe("approved");
        const pending = await Effect.runPromise(adapter.listPendingApprovals(first.runId));
        expect(pending).toHaveLength(1);
        expect(pending[0]?.status).toBe("requested");
        const nextRequest = JSON.parse(pending[0]?.requestJson ?? "{}");
        expect(nextRequest).toEqual(
          expect.objectContaining({
            kind: "ReplayUnsafeApproval",
            fingerprint: expect.any(String),
            authorizedAttempt: expect.any(Number),
          }),
        );
        expect(nextRequest.fingerprint).not.toBe(firstRequest.fingerprint);
        expect(nextRequest.authorizedAttempt).toBeGreaterThan(firstRequest.authorizedAttempt);
        expect(nextRequest.offending).toHaveLength(2);
        const requestedEvents = await Effect.runPromise(adapter.listEventsByType(first.runId, "ApprovalRequested"));
        expect(requestedEvents).toHaveLength(2);
        expect(JSON.parse(requestedEvents[1]?.payloadJson ?? "{}").iteration).toBe(pending[0].iteration);

        await Effect.runPromise(approveNode(adapter, first.runId, "publish", 0, "retry new call", "operator"));
        const finished = await Effect.runPromise(
          runWorkflow(fixture.workflow, {
            input: {},
            runId: first.runId,
            resume: true,
          }),
        );
        expect(finished.status).toBe("finished");
        expect(invocations).toEqual([null, null, null]);
        expect((await Effect.runPromise(adapter.getApproval(first.runId, "publish", 0)))?.status).toBe("approved");
        expect(
          (await Effect.runPromise(adapter.getApproval(first.runId, "publish", pending[0].iteration)))?.status,
        ).toBe("approved");
        const grantedEvents = await Effect.runPromise(adapter.listEventsByType(first.runId, "ApprovalGranted"));
        expect(JSON.parse(grantedEvents[1]?.payloadJson ?? "{}").iteration).toBe(pending[0].iteration);
      } finally {
        fixture.cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test.each([
    ["idempotent tool", true, false],
    ["keyed non-idempotent tool", false, true],
  ])(
    "replays a safe %s",
    async (_label, idempotent, keyed) => {
      const invocations = [];
      const name = keyed ? "keyed-publish" : "idempotent-publish";
      const tool = makeTool({ name, idempotent, keyed, invocations });
      const fixture = buildWorkflow(makeAgent(tool, name), name);
      try {
        const result = await Effect.runPromise(runWorkflow(fixture.workflow, { input: {} }));
        expect(result.status).toBe("finished");
        expect(invocations).toHaveLength(2);
        if (keyed) {
          expect(invocations[0]).toBeTruthy();
          expect(invocations[1]).toBe(invocations[0]);
        }
        const adapter = new SmithersDb(fixture.db);
        expect(await Effect.runPromise(adapter.getApproval(result.runId, "publish", 0))).toBeUndefined();
      } finally {
        fixture.cleanup();
      }
    },
    TIMEOUT_MS,
  );
});
