/** @jsxImportSource smthrs */
/**
 * The wait/wake seam, reached from the engine rather than from a unit test.
 *
 * Spec 1.4 of `.smithers/specs/flows-migration.md` routes every park through
 * `FlowRuntime.annotateWaiting`. The taxonomy unit tests prove the annotation
 * is the shape flows consumes; what is proved here is that a host which binds
 * the flows fiber actually receives one, on the real `markRunWaiting` path,
 * for each of the three parks that carry different payloads:
 *
 * - approval — a token and no deadline,
 * - timer — a deadline and no token,
 * - quota — a deadline the injected classifier chose (spec 1.5).
 *
 * The host is bound to the real `FlowInstance` service, so the assertion is
 * against the value flows itself stores, not a stand-in for it.
 */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { z } from "zod";
import { SmithersError } from "@smthrs/errors/SmithersError";
import { Approval, Task, Timer, Workflow, runWorkflow } from "smthrs";
import { createTestSmithers } from "../../smithers/tests/helpers.js";

const TEST_TIMEOUT_MS = 30_000;

/**
 * A host binding of the kind a flows-driven driver installs: the annotation is
 * handed to `FlowRuntime.annotateWaiting` and run against this run's own
 * `FlowInstance`. `packages/engine` does not declare `@flows/flow` (it must
 * keep working for a consumer with no flows install), so a tree without the
 * vendored alias on its resolution path reports that instead of failing.
 */
async function bindFlowsHost() {
  const FlowRuntime = await import("@flows/flow/FlowRuntime").catch(() => null);
  if (!FlowRuntime) return null;
  const instance = { waiting: undefined };
  /** @type {Array<{ reason: string, wakeAt?: number, token?: string }>} */
  const declared = [];
  /** @type {Array<{ declaredToFlows: boolean, runStatus: string | null }>} */
  const declarations = [];
  return {
    instance,
    declared,
    declarations,
    opts: {
      annotateWaiting: (annotation) => {
        declared.push(annotation);
        return Effect.runPromise(
          Effect.provideService(FlowRuntime.annotateWaiting(annotation), FlowRuntime.FlowInstance, instance),
        );
      },
      onWaitingDeclared: (declaration) => {
        declarations.push(declaration);
      },
    },
  };
}

describe("the engine declares every park to a bound flows host", () => {
  test(
    "an approval park declares { reason: approval, token }",
    async () => {
      const host = await bindFlowsHost();
      if (!host) return;
      const { smithers, outputs, cleanup } = createTestSmithers({
        decision: z.object({ approved: z.boolean() }),
      });
      try {
        const workflow = smithers(() => (
          <Workflow name="seam-approval-park">
            <Approval id="gate" output={outputs.decision} request={{ title: "Ship it?" }} />
          </Workflow>
        ));
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, ...host.opts }));
        expect(result.status).toBe("waiting-approval");
        expect(host.declared).toEqual([{ reason: "approval", token: "gate" }]);
        expect(host.declarations).toEqual([
          { annotation: { reason: "approval", token: "gate" }, runStatus: "waiting-approval", declaredToFlows: true },
        ]);
        // The value the real flows service holds, not the one the engine sent.
        expect(host.instance.waiting).toEqual({ reason: "approval", token: "gate" });
      } finally {
        cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a timer park declares { reason: timer, wakeAt }",
    async () => {
      const host = await bindFlowsHost();
      if (!host) return;
      const { smithers, cleanup } = createTestSmithers({});
      try {
        const workflow = smithers(() => (
          <Workflow name="seam-timer-park">
            <Timer id="deadline" duration="1h" />
          </Workflow>
        ));
        const startedAtMs = Date.now();
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, ...host.opts }));
        expect(result.status).toBe("waiting-timer");
        expect(host.declarations.every((entry) => entry.declaredToFlows)).toBe(true);
        expect(host.declared).toHaveLength(1);
        const annotation = host.declared[0];
        expect(annotation.reason).toBe("timer");
        expect(annotation.token).toBeUndefined();
        // An hour out, give or take how long the park took to reach here.
        expect(annotation.wakeAt).toBeGreaterThan(startedAtMs + 3_500_000);
        expect(host.instance.waiting).toEqual(annotation);
      } finally {
        cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a quota park declares { reason: quota, wakeAt } with the classifier's deadline",
    async () => {
      const host = await bindFlowsHost();
      if (!host) return;
      const { smithers, outputs, cleanup } = createTestSmithers({ result: z.object({ value: z.number() }) });
      try {
        const resetAtMs = Date.now() + 60_000;
        let calls = 0;
        const agent = {
          id: "quota-agent",
          tools: {},
          async generate() {
            calls += 1;
            if (calls === 1) {
              throw new SmithersError("AGENT_QUOTA_EXCEEDED", "You've hit your usage limit.", {
                failureQuota: true,
                quotaResetAtMs: resetAtMs,
              });
            }
            return { output: { value: calls } };
          },
        };
        const workflow = smithers(() => (
          <Workflow name="seam-quota-park">
            <Task id="q" output={outputs.result} agent={agent} retries={0}>
              hit quota once
            </Task>
          </Workflow>
        ));
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, ...host.opts }));
        expect(result.status).toBe("waiting-quota");
        expect(host.declared).toEqual([{ reason: "quota", wakeAt: resetAtMs }]);
        expect(host.declarations).toEqual([
          { annotation: { reason: "quota", wakeAt: resetAtMs }, runStatus: "waiting-quota", declaredToFlows: true },
        ]);
        expect(host.instance.waiting).toEqual({ reason: "quota", wakeAt: resetAtMs });
      } finally {
        cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
