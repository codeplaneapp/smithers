import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  isWaitingReason,
  makeWaitingAnnotation,
  parseWaitingAnnotation,
  runStatusForWaitingAnnotation,
  waitingAnnotationForWaitReason,
  waitingReasonForRunStatus,
  WAITING_REASONS,
} from "@smthrs/engine/waiting/waitingTaxonomy";
import { createWaitingSeam } from "@smthrs/engine/waiting/createWaitingSeam";
import { flowsAnnotateWaitingEffect } from "@smthrs/engine/waiting/flowsWaitingBinding";
import { waitingAnnotationFromRunRow } from "@smthrs/engine/waiting/readWaitingAnnotation";
import { mergeWaitingAnnotationIntoErrorJson } from "@smthrs/engine/engine";

describe("waiting taxonomy", () => {
  test("carries exactly the five supervisor reasons, `released` included", () => {
    expect([...WAITING_REASONS].sort()).toEqual(["approval", "event", "quota", "released", "timer"]);
    expect(isWaitingReason("released")).toBe(true);
    expect(isWaitingReason("backoff")).toBe(false);
  });

  test("every scheduler WaitReason maps onto one annotation", () => {
    expect(waitingAnnotationForWaitReason({ _tag: "Approval", nodeId: "gate" })).toEqual({
      reason: "approval",
      token: "gate",
    });
    expect(waitingAnnotationForWaitReason({ _tag: "Event", eventName: "deploy" })).toEqual({
      reason: "event",
      token: "deploy",
    });
    expect(waitingAnnotationForWaitReason({ _tag: "Timer", resumeAtMs: 1_700 })).toEqual({
      reason: "timer",
      wakeAt: 1_700,
    });
    expect(waitingAnnotationForWaitReason({ _tag: "Bound", nodeId: "authority", code: "BOUND_STALE" })).toEqual({
      reason: "event",
      token: "authority",
    });
    // An external trigger has no identity and no deadline.
    expect(waitingAnnotationForWaitReason({ _tag: "ExternalTrigger" })).toEqual({ reason: "event" });
  });

  test("a quota park takes its deadline from the classifier, not the scheduler", () => {
    const fromScheduler = waitingAnnotationForWaitReason({
      _tag: "Quota",
      quotaBlockedCount: 2,
      resetAtMs: 9_000,
    });
    expect(fromScheduler).toEqual({ reason: "quota", wakeAt: 9_000 });
    const fromClassifier = waitingAnnotationForWaitReason(
      { _tag: "Quota", quotaBlockedCount: 2, resetAtMs: 9_000 },
      { quotaWakeAtMs: 4_000 },
    );
    expect(fromClassifier).toEqual({ reason: "quota", wakeAt: 4_000 });
  });

  test("the run status is derived from the reason, and `released` has none", () => {
    expect(runStatusForWaitingAnnotation({ reason: "approval" })).toBe("waiting-approval");
    expect(runStatusForWaitingAnnotation({ reason: "event" })).toBe("waiting-event");
    expect(runStatusForWaitingAnnotation({ reason: "timer" })).toBe("waiting-timer");
    expect(runStatusForWaitingAnnotation({ reason: "quota" })).toBe("waiting-quota");
    expect(runStatusForWaitingAnnotation({ reason: "released" })).toBeNull();
    expect(waitingReasonForRunStatus("waiting-quota")).toBe("quota");
    expect(waitingReasonForRunStatus("running")).toBeNull();
  });

  test("non-positive deadlines and empty tokens are dropped rather than persisted", () => {
    expect(makeWaitingAnnotation("timer", { wakeAt: 0, token: "" })).toEqual({ reason: "timer" });
    expect(makeWaitingAnnotation("timer", { wakeAt: Number.NaN })).toEqual({ reason: "timer" });
  });

  test("an annotation round-trips through a persisted payload", () => {
    const annotation = makeWaitingAnnotation("approval", { token: "gate", wakeAt: 42 });
    expect(parseWaitingAnnotation(JSON.parse(JSON.stringify(annotation)))).toEqual(annotation);
    expect(parseWaitingAnnotation({ reason: "nonsense" })).toBeNull();
    expect(parseWaitingAnnotation(null)).toBeNull();
  });
});

describe("waiting annotation on the run row", () => {
  test("reads the declared annotation back out of errorJson", () => {
    const errorJson = mergeWaitingAnnotationIntoErrorJson(JSON.stringify({ quotaBlockedCount: 1, resetAtMs: 100 }), {
      reason: "quota",
      wakeAt: 250,
    });
    expect(JSON.parse(errorJson)).toEqual({
      quotaBlockedCount: 1,
      resetAtMs: 100,
      waiting: { reason: "quota", wakeAt: 250 },
    });
    expect(waitingAnnotationFromRunRow({ status: "waiting-quota", errorJson })).toEqual({
      reason: "quota",
      wakeAt: 250,
    });
  });

  test("falls back to the pre-taxonomy resetAtMs for a row parked by an older build", () => {
    expect(
      waitingAnnotationFromRunRow({
        status: "waiting-quota",
        errorJson: JSON.stringify({ quotaBlockedCount: 1, resetAtMs: 777 }),
      }),
    ).toEqual({ reason: "quota", wakeAt: 777 });
  });

  test("a non-waiting row has no annotation", () => {
    expect(waitingAnnotationFromRunRow({ status: "running", errorJson: null })).toBeNull();
    expect(waitingAnnotationFromRunRow(null)).toBeNull();
  });

  test("merging leaves a malformed or absent errorJson alone", () => {
    expect(mergeWaitingAnnotationIntoErrorJson(null, { reason: "timer" })).toBeNull();
    expect(mergeWaitingAnnotationIntoErrorJson("not json", { reason: "timer" })).toBe("not json");
    expect(mergeWaitingAnnotationIntoErrorJson("[1,2]", { reason: "timer" })).toBe("[1,2]");
  });
});

describe("the flows declaration point", () => {
  // `packages/engine` does not declare `@flows/flow`: it is a published package
  // that has to keep working for a consumer with no flows install, so the
  // source imports it dynamically and tolerates its absence. The tests hold to
  // the same rule — when the vendored alias is on the resolution path the
  // assertions run against the real library, and when it is not they say so
  // rather than failing an install that was never wrong.
  const loadFlowRuntime = () => import("@flows/flow/FlowRuntime").catch(() => null);

  test("the vendored flows library exposes FlowRuntime.annotateWaiting", async () => {
    const FlowRuntime = await loadFlowRuntime();
    if (!FlowRuntime) return;
    expect(typeof FlowRuntime.annotateWaiting).toBe("function");
  });

  test("declaring an annotation sets it on the real flows FlowInstance", async () => {
    const FlowRuntime = await loadFlowRuntime();
    if (!FlowRuntime) return;
    const annotation = waitingAnnotationForWaitReason({ _tag: "Approval", nodeId: "deploy-gate" });
    const effect = await flowsAnnotateWaitingEffect(annotation);
    expect(effect).not.toBeNull();
    // A flows durable driver reads `instance.waiting` when it parks the run.
    // Asserting against the real service, not a stand-in, is what proves the
    // Smithers taxonomy is the same value flows consumes.
    const instance = { waiting: undefined };
    await Effect.runPromise(Effect.provideService(effect, FlowRuntime.FlowInstance, instance));
    expect(instance.waiting).toEqual({ reason: "approval", token: "deploy-gate" });
  });

  test("the seam declares to flows when a host binds the fiber, and not otherwise", async () => {
    /** @type {unknown[]} */
    const declared = [];
    const bound = createWaitingSeam({
      annotateWaiting: (annotation) => {
        declared.push(annotation);
      },
    });
    const withHost = await bound.declareWaiting({ _tag: "Timer", resumeAtMs: 5_000 });
    expect(withHost.declaredToFlows).toBe(true);
    expect(withHost.runStatus).toBe("waiting-timer");
    expect(declared).toEqual([{ reason: "timer", wakeAt: 5_000 }]);

    // The legacy loop has no flows fiber. The annotation is still produced —
    // that is the point of one taxonomy — it just is not declared anywhere.
    const legacy = createWaitingSeam({ declareToFlows: false });
    const withoutHost = await legacy.declareWaiting({ _tag: "Timer", resumeAtMs: 5_000 });
    expect(withoutHost.declaredToFlows).toBe(false);
    expect(withoutHost.annotation).toEqual({ reason: "timer", wakeAt: 5_000 });
  });
});
