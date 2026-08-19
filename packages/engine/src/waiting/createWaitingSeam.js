/**
 * The wait/wake seam.
 *
 * Every park in the engine goes through here, and the seam owns three things
 * the call sites used to each do their own way:
 *
 * 1. It turns the scheduler's `WaitReason` into one `WaitingAnnotation`.
 * 2. It asks the injected `classifyError` / `resolveRetry` services what the
 *    wake deadline is, so provider quirks stay in Smithers and never move into
 *    an executor (spec 1.5).
 * 3. It declares that annotation to flows through `FlowRuntime.annotateWaiting`
 *    when a flows fiber is driving, and hands it back to the caller to persist
 *    when the legacy loop is.
 *
 * @typedef {import("./WaitingAnnotation.ts").WaitingAnnotation} WaitingAnnotation
 * @typedef {import("@smthrs/scheduler/WaitReason").WaitReason} WaitReason
 * @typedef {import("../classify/WaitWakeClassifiers.ts").WaitWakeClassifiers} WaitWakeClassifiers
 */
import { defaultWaitWakeClassifiers } from "../classify/defaultWaitWakeClassifiers.js";
import { loadFlowsWaitingBinding } from "./flowsWaitingBinding.js";
import { waitingAnnotationForWaitReason, runStatusForWaitingAnnotation } from "./waitingTaxonomy.js";

/**
 * @typedef {object} WaitingSeamOptions
 * @property {Partial<WaitWakeClassifiers>} [classifiers] injected provider policy
 * @property {(annotation: WaitingAnnotation) => unknown} [annotateWaiting] override the flows declaration point
 * @property {boolean} [declareToFlows] force the flows declaration on or off
 * @property {() => number} [nowMs]
 */

/**
 * @typedef {object} WaitingDeclaration
 * @property {WaitingAnnotation} annotation
 * @property {string | null} runStatus the durable status to persist, null for `released`
 * @property {boolean} declaredToFlows whether the flows fiber accepted the annotation
 */

/**
 * @param {WaitingSeamOptions} [options]
 */
export function createWaitingSeam(options = {}) {
  const classifiers = { ...defaultWaitWakeClassifiers, ...options.classifiers };
  const nowMs = options.nowMs ?? (() => Date.now());
  // Spec stage 1: everything flows-routed stays behind the engine selector
  // until 1.7. On the legacy loop there is no flows fiber to declare to, and
  // attempting it on every park would pay an import plus a guaranteed Effect
  // failure for nothing.
  const flowsEnabled =
    options.declareToFlows ?? (options.annotateWaiting != null || process.env.SMITHERS_ENGINE === "flows");

  /**
   * Declare the annotation to flows. Returns false whenever no flows fiber is
   * driving this park, which is every legacy-engine park; the caller then owns
   * persistence. A failure here is never fatal: the annotation is still the
   * durable truth the caller writes.
   * @param {WaitingAnnotation} annotation
   * @returns {Promise<boolean>}
   */
  const declareToFlows = async (annotation) => {
    if (!flowsEnabled) return false;
    try {
      // `FlowRuntime.annotateWaiting` requires the `FlowInstance` service, so
      // it can only be run inside the flow's own fiber. A flows-driven host
      // supplies `annotateWaiting` bound to that fiber; without one there is
      // nothing to declare to, which is every legacy-engine park.
      if (!options.annotateWaiting) return false;
      // Presence of the binding is still checked: a host that thinks it is on
      // the flows route without the library installed should learn that here
      // rather than silently park under a taxonomy nobody reads.
      if ((await loadFlowsWaitingBinding()) == null) return false;
      await options.annotateWaiting(annotation);
      return true;
    } catch {
      return false;
    }
  };

  return {
    classifiers,
    /**
     * Classify a failed attempt with the injected provider policy.
     * @param {unknown} failure
     */
    classifyError: (failure) => classifiers.classifyError(failure, { nowMs: nowMs() }),
    /**
     * Resolve what a classified failure should do next.
     * @param {unknown} failure
     * @param {{ attemptsUsed: number; retries: number }} budget
     */
    resolveRetry: (failure, budget) =>
      classifiers.resolveRetry(classifiers.classifyError(failure, { nowMs: nowMs() }), {
        ...budget,
        nowMs: nowMs(),
      }),
    /**
     * Declare an annotation the caller already built.
     * @param {WaitingAnnotation} annotation
     * @returns {Promise<WaitingDeclaration>}
     */
    declareAnnotation: async (annotation) => ({
      annotation,
      runStatus: runStatusForWaitingAnnotation(annotation),
      declaredToFlows: await declareToFlows(annotation),
    }),
    /**
     * The one park entry point.
     * @param {WaitReason} waitReason
     * @param {{ quotaWakeAtMs?: number | undefined }} [context]
     * @returns {Promise<WaitingDeclaration>}
     */
    declareWaiting: async (waitReason, context = {}) => {
      const annotation = waitingAnnotationForWaitReason(waitReason, context);
      const declaredToFlows = await declareToFlows(annotation);
      return {
        annotation,
        runStatus: runStatusForWaitingAnnotation(annotation),
        declaredToFlows,
      };
    },
  };
}

/** @typedef {ReturnType<typeof createWaitingSeam>} WaitingSeam */
