import * as Action from "@flows/flow/Action";
import { AgentStep } from "@flows/harness/AgentStep";
import * as Schema from "effect/Schema";

/**
 * The durability tier a Smithers task carries into flows.
 *
 * `<Task sideEffect>` is the only declaration Smithers has about external
 * effects, and it says two things: whether the effect is idempotent and how to
 * undo it. That maps onto the flows tiers exactly — an undo makes a step
 * compensable, an effect with no undo is irreversible, and no declared effect
 * at all is sealed.
 */
export type Tier = "sealed" | "compensable" | "irreversible";

/** The Smithers task kinds this package compiles. */
export type TaskKind = "agent" | "compute" | "static" | "human";

/**
 * The payload a compiled agent step is dispatched with.
 *
 * `step` is the harness's own `AgentStep`: the serializable half of one agent
 * run. The harness is what executes it, so the declaration here carries no
 * implementation.
 */
export const AgentCall = Schema.Struct({
  nodeId: Schema.String,
  step: AgentStep,
});

/** The payload a compiled compute step is dispatched with. */
export const ComputeCall = Schema.Struct({
  nodeId: Schema.String,
  /** SHA-256 of the `computeFn` source, so a body edit re-keys the step. */
  source: Schema.String,
});

/** The payload a compiled static step is dispatched with. */
export const StaticCall = Schema.Struct({
  nodeId: Schema.String,
  value: Schema.Unknown,
});

const tierSuffix = (tier: Tier): string => (tier === "sealed" ? "" : `.${tier}`);

/**
 * The dispatch tag for one (kind, tier) pair.
 *
 * The tier is part of the tag because a flows action declares one tier, and an
 * implementation table resolves by tag. Two Smithers tasks of the same kind
 * and different tiers are therefore two declarations, not one declaration with
 * a per-call tier the runtime would have no way to honour.
 */
export const actionTag = (kind: TaskKind, tier: Tier): string => `smithers/${kind}${tierSuffix(tier)}`;

const TIERS: readonly Tier[] = ["sealed", "compensable", "irreversible"];

const declare = <Fields extends Schema.Struct.Fields>(
  kind: TaskKind,
  payload: Schema.Struct<Fields>,
  nondeterministic?: true,
) => {
  const makeOne = (tier: Tier) =>
    Action.make(actionTag(kind, tier), {
      payload,
      success: Schema.Unknown,
      tier,
      ...(nondeterministic === undefined ? {} : { nondeterministic }),
    });
  const byTier = new Map<Tier, ReturnType<typeof makeOne>>();
  for (const tier of TIERS) byTier.set(tier, makeOne(tier));
  return byTier as ReadonlyMap<Tier, ReturnType<typeof makeOne>>;
};

/**
 * Every action declaration this compiler emits, keyed by kind and tier.
 *
 * The table is built once and shared, so two compilations of the same workflow
 * call the same declaration object and a runtime that registered an
 * implementation for a tag serves both.
 */
export const actions = {
  agent: declare("agent", AgentCall, true),
  compute: declare("compute", ComputeCall),
  human: declare("human", ComputeCall),
  static: declare("static", StaticCall),
} as const;

/** The declaration a task of this kind and tier is dispatched through. */
export const actionFor = (kind: TaskKind, tier: Tier) => {
  const family = actions[kind];
  const declaration = family.get(tier);
  /* v8 ignore next -- every tier is registered above */
  if (declaration === undefined) throw new Error(`No ${kind} action declared for tier ${tier}`);
  return declaration;
};

/** Every declaration, flattened, for a host that registers implementations. */
export const allActions = Object.values(actions).flatMap((family) => [...family.values()]);
