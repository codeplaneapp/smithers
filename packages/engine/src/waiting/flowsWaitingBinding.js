/**
 * The binding from the waiting taxonomy onto flows' own declaration point.
 *
 * `@flows/flow` is the vendored flows library (`vendor/flows/README.md`): the
 * bare `@smthrs/flow` name belongs to this workspace, so the flows copy is
 * only reachable under its alias. The import is dynamic and failure-tolerant
 * on purpose — `packages/engine` is a published package and must keep working
 * for a consumer who has no flows install, and the legacy engine never needs
 * the binding at all.
 *
 * `FlowRuntime.annotateWaiting` is an Effect that requires the `FlowInstance`
 * service, so it only succeeds inside a flows-driven fiber. Outside one — which
 * is every legacy-engine park until stage 1.3 routes runs onto `FlowEngine` —
 * the caller keeps the annotation and persists it itself. Both paths produce
 * the same `{ reason, wakeAt?, token? }`, which is the point: the taxonomy is
 * shared even while the executors are not.
 *
 * @typedef {import("./WaitingAnnotation.ts").WaitingAnnotation} WaitingAnnotation
 */

/** @type {Promise<{ annotateWaiting: (a: WaitingAnnotation | undefined) => unknown } | null> | null} */
let cached = null;

/**
 * Resolve flows' `FlowRuntime` once per process.
 * @returns {Promise<{ annotateWaiting: (a: WaitingAnnotation | undefined) => unknown } | null>}
 */
export function loadFlowsWaitingBinding() {
  cached ??= import("@flows/flow/FlowRuntime")
    .then((module) => {
      const annotateWaiting = /** @type {Record<string, unknown>} */ (module).annotateWaiting;
      return typeof annotateWaiting === "function"
        ? { annotateWaiting: /** @type {(a: WaitingAnnotation | undefined) => unknown} */ (annotateWaiting) }
        : null;
    })
    .catch(() => null);
  return cached;
}

/**
 * The raw `FlowRuntime.annotateWaiting` Effect for an annotation, or null when
 * flows is not installed.
 *
 * This is the composition point for a flows-driven host: the Effect requires
 * `FlowInstance`, so it has to be run inside the flow's own fiber, not from
 * the outside. Handing back the Effect rather than running it is what lets the
 * declaration happen where the instance actually lives.
 *
 * @param {WaitingAnnotation | undefined} annotation
 * @returns {Promise<unknown | null>}
 */
export async function flowsAnnotateWaitingEffect(annotation) {
  const binding = await loadFlowsWaitingBinding();
  return binding ? binding.annotateWaiting(annotation) : null;
}

/** Test seam: drop the memoized resolution. */
export function resetFlowsWaitingBinding() {
  cached = null;
}
