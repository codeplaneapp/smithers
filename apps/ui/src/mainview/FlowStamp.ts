/*
 * `data-flow` on affordances the host does not render itself.
 *
 * The launch law is that every visible affordance names the flow behind it, and
 * `data-flow` is how it says so — the slash listing, the launch checklist and
 * the agent's own manifest all read it. A few affordances are rendered by
 * `@smthrs/ui` (the composer's Send and Stop buttons, the world file tree's
 * rows) and the component accepts no pass-through attributes, so the host
 * stamps them at the mount point instead of forking the component.
 *
 * The honest fix is a pass-through prop on those components; see
 * LIBRARY-CHANGE-REQUESTS.md. Until then this keeps the law observable rather
 * than merely intended.
 */

/** One selector and the registered flow the elements it matches invoke. */
export type FlowBindingHint = readonly [selector: string, flow: string]

/**
 * Stamps `data-flow` on every match under `root`.
 *
 * Written as a React ref callback: an inline callback re-runs on every commit,
 * so an affordance that appears mid-turn (Stop) or mid-list (a new note) is
 * stamped as soon as it exists. Stamping is idempotent and never overrides a
 * `data-flow` the element already carries.
 */
export const stampFlows = (hints: ReadonlyArray<FlowBindingHint>) => (root: HTMLElement | null): void => {
  if (root === null) return
  for (const [selector, flow] of hints) {
    for (const element of root.querySelectorAll<HTMLElement>(selector)) {
      if (element.getAttribute("data-flow") === null) element.setAttribute("data-flow", flow)
    }
  }
}

/** One selector and the `data-testid` the elements it matches carry (LOCAL-APP.md contract). */
export type TestIdHint = readonly [selector: string, testId: string]

/**
 * Stamps `data-testid` on every match under `root`, for the Playwright
 * contract on affordances `@smthrs/ui` renders without pass-through
 * attributes (the composer's Send button). Same ref-callback shape and the
 * same idempotence as `stampFlows`.
 */
export const stampTestIds = (hints: ReadonlyArray<TestIdHint>) => (root: HTMLElement | null): void => {
  if (root === null) return
  for (const [selector, testId] of hints) {
    for (const element of root.querySelectorAll<HTMLElement>(selector)) {
      if (element.getAttribute("data-testid") === null) element.setAttribute("data-testid", testId)
    }
  }
}

/** Runs several ref callbacks against one element. */
export const composeRefs = (...refs: ReadonlyArray<(root: HTMLElement | null) => void>) => (root: HTMLElement | null): void => {
  for (const ref of refs) ref(root)
}
