/**
 * The journal entry types the control verbs write.
 *
 * Values live in `.js` here, not in `RunControl.ts`: every `.ts` file under
 * `packages/engine/src` is types-only, so a runtime import never depends on a
 * TypeScript loader.
 */

/** Journaled before the durable flip, with the actor and reason. */
export const RUN_CONTROL_EVENT_TYPE = "RunControlRequested";

/** Journaled after the flip, with the observed outcome. */
export const RUN_CONTROL_APPLIED_EVENT_TYPE = "RunControlApplied";
