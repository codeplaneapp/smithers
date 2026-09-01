/**
 * The refusals a plan-time build raises instead of producing a wrong plan.
 *
 * Every one of these fails LOUDLY at build time: a planned value that was computed on must not
 * bake `NaN` into a plan, an arm that returned something other than a node must
 * not silently vanish from the topology, and a recursive `.call()` must direct
 * the author to `.to()` or `.child()` rather than expanding forever. Each
 * failure therefore names the site (`node` plus the recorded property `path`)
 * and states the fix in `message`, because the author reading it is mid-body
 * and needs the correction, not a classification.
 *
 * The codes are a closed schema literal so a caller can switch on them, and so
 * a new refusal is a deliberate addition rather than a new free-form string.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"

/**
 * The stable code of a build refusal.
 *
 * `planned_value_computed` is a body computing on a step result;
 * `invalid_all_member` is a non-node handed to {@link module:Node.all};
 * `invalid_continuation` is a branch arm or continuation that did not return a
 * node; `recursion_requires_boundary` is a flow calling itself inline, which
 * has to become a trampoline handoff or an explicit child boundary;
 * `placement_requires_boundary` is an inline call whose callee declares a
 * placement the enclosing flow cannot satisfy, which has to become that same
 * explicit child boundary; `cyclic_payload` is a payload that contains itself,
 * which no plan could serialize or hash; `payload_too_deep` is a payload
 * nested past the build bound, which has to be flattened into shallower data;
 * `graph_too_deep` is authored topology nested past the build bound, which
 * has to be split with `.child()` boundaries or trampoline handoffs;
 * `duplicate_node` is two structural graph addresses resolving to one durable
 * node id;
 * `invalid_priority` is a scheduling priority that is not a safe integer,
 * which no ordering could compare; `invalid_payload` is a payload member that
 * cannot be captured as inert JSON without executing author code or losing
 * identity. The two
 * depth refusals exist because graph building walks with an explicit stack
 * and refuses at a bound, rather than recursing until the native stack
 * overflows without a typed error.
 *
 * @since 0.1.0
 * @category schemas
 * @slop
 */
export const GraphBuildErrorCode = Schema.Literals([
  "planned_value_computed",
  "invalid_all_member",
  "invalid_continuation",
  "recursion_requires_boundary",
  "placement_requires_boundary",
  "cyclic_payload",
  "payload_too_deep",
  "graph_too_deep",
  "duplicate_node",
  "invalid_priority",
  "invalid_payload"
])

/**
 * The value form of {@link GraphBuildErrorCode}.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type GraphBuildErrorCode = typeof GraphBuildErrorCode.Type

/**
 * A build the planner refuses, naming the site and the fix.
 *
 * `node` is the node reference the failure belongs to — a planned value's
 * origin node, an `all` member name, or a branch arm. `path` is the property
 * path recorded on a planned value before it was misused, empty for every
 * other code.
 *
 * @since 0.1.0
 * @category errors
 * @slop
 */
export class GraphBuildError extends Schema.TaggedError<GraphBuildError>()("@smthrs/plan/GraphBuildError", {
  code: GraphBuildErrorCode,
  node: Schema.String,
  path: Schema.Array(Schema.String),
  message: Schema.String
}) {}
