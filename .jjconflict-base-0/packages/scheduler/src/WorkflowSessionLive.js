import { Layer } from "effect";
import { WorkflowSession } from "./WorkflowSession.js";
import { makeWorkflowSession } from "./makeWorkflowSession.js";

/**
 * WARNING — do not consume this layer as-is. `Layer.sync` builds **one** shared
 * `makeWorkflowSession()` instance for the whole layer scope, but a workflow
 * session carries per-run state, so sharing it across runs is a correctness bug.
 * The engine intentionally bypasses this Tag and constructs a fresh session per
 * run via `makeWorkflowSession()` directly — which is why nothing yields
 * `WorkflowSession` today. Before any consumer reads the Tag, rework this into a
 * per-run/scoped provider (e.g. `Layer.scoped` or a factory service) so each run
 * gets its own session.
 *
 * @type {Layer.Layer<WorkflowSession, never, never>}
 */
export const WorkflowSessionLive = Layer.sync(WorkflowSession, makeWorkflowSession);
