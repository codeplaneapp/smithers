/**
 * The Context Contract: the structured agreement the Context Engineering Console
 * builds up as it interviews the user. It captures everything an agent needs
 * before it starts work — the goal and scope, the non-goals and assumptions, the
 * decisions already made and the questions still open, the inputs/outputs, the
 * tools/skills it may use, what to remember vs forget, the acceptance criteria,
 * the side effects (and which need approval), and the report it should produce.
 *
 * This module is pure data + two helpers (no React, no zustand, no clock), so the
 * contract can be built, merged, and unit-tested without a DOM. Every array field
 * defaults to an empty array and the scalar `reportSpec` defaults to null, so a
 * fresh contract is always fully shaped — callers never have to null-check a
 * missing field.
 */

/** One declared input: a named thing the work consumes, with where it comes from. */
export type ContextInput = {
  name: string;
  /** Where the input is sourced from, or null when it is still unresolved. */
  source: string | null;
};

/**
 * What the agent should and should not carry forward into cross-run memory.
 * `persist` is remembered; `doNotPersist` is explicitly forgotten (secrets,
 * scratch state) so it never leaks into a later run.
 */
export type ContextMemory = {
  persist: string[];
  doNotPersist: string[];
};

/**
 * One acceptance criterion the work is graded against. `verificationMethod` is
 * how it gets checked (a command, a review step), or null when not yet decided.
 * `blocking` criteria must pass before the work is considered done.
 */
export type AcceptanceCriterion = {
  criterion: string;
  verificationMethod: string | null;
  blocking: boolean;
};

/**
 * One side effect the work will have on the world. `requiresApproval` gates the
 * effect behind a human approval before it is allowed to happen.
 */
export type SideEffect = {
  description: string;
  requiresApproval: boolean;
};

/**
 * The full Context Contract. Every list field defaults to `[]` and `reportSpec`
 * to `null` (see {@link emptyContract}), so a contract is always fully shaped.
 */
export type ContextContract = {
  goal: string;
  scope: string;
  nonGoals: string[];
  assumptions: string[];
  decisions: string[];
  openQuestions: string[];
  deferredQuestions: string[];
  inputs: ContextInput[];
  outputs: string[];
  tools: string[];
  skills: string[];
  memory: ContextMemory;
  acceptanceCriteria: AcceptanceCriterion[];
  sideEffects: SideEffect[];
  /** The report the work should produce, or null when none is specified. */
  reportSpec: string | null;
};

/**
 * A fresh, fully-shaped contract: empty `goal`/`scope` strings, every list empty,
 * empty memory buckets, and a null `reportSpec`. Returns a new object each call
 * (fresh arrays and nested objects), so callers can mutate the result freely
 * without aliasing a shared default.
 */
export function emptyContract(): ContextContract {
  return {
    goal: "",
    scope: "",
    nonGoals: [],
    assumptions: [],
    decisions: [],
    openQuestions: [],
    deferredQuestions: [],
    inputs: [],
    outputs: [],
    tools: [],
    skills: [],
    memory: { persist: [], doNotPersist: [] },
    acceptanceCriteria: [],
    sideEffects: [],
    reportSpec: null,
  };
}

/**
 * Merge a partial patch onto a base contract, returning a new contract — `base`
 * is never mutated. A field is overridden only when the patch supplies it
 * (`!== undefined`), so a sparse patch touches just the keys it names. The nested
 * `memory` object is merged one level deep (its `persist` / `doNotPersist`
 * buckets are overridden independently), so a patch can replace one bucket
 * without clobbering the other. All other fields, including the array fields, are
 * replaced wholesale by the patch's value (no element-level union).
 */
export function mergeContract(
  base: ContextContract,
  patch: Partial<ContextContract>,
): ContextContract {
  return {
    goal: patch.goal !== undefined ? patch.goal : base.goal,
    scope: patch.scope !== undefined ? patch.scope : base.scope,
    nonGoals: patch.nonGoals !== undefined ? patch.nonGoals : base.nonGoals,
    assumptions: patch.assumptions !== undefined ? patch.assumptions : base.assumptions,
    decisions: patch.decisions !== undefined ? patch.decisions : base.decisions,
    openQuestions: patch.openQuestions !== undefined ? patch.openQuestions : base.openQuestions,
    deferredQuestions:
      patch.deferredQuestions !== undefined ? patch.deferredQuestions : base.deferredQuestions,
    inputs: patch.inputs !== undefined ? patch.inputs : base.inputs,
    outputs: patch.outputs !== undefined ? patch.outputs : base.outputs,
    tools: patch.tools !== undefined ? patch.tools : base.tools,
    skills: patch.skills !== undefined ? patch.skills : base.skills,
    memory:
      patch.memory !== undefined
        ? {
            persist:
              patch.memory.persist !== undefined ? patch.memory.persist : base.memory.persist,
            doNotPersist:
              patch.memory.doNotPersist !== undefined
                ? patch.memory.doNotPersist
                : base.memory.doNotPersist,
          }
        : base.memory,
    acceptanceCriteria:
      patch.acceptanceCriteria !== undefined ? patch.acceptanceCriteria : base.acceptanceCriteria,
    sideEffects: patch.sideEffects !== undefined ? patch.sideEffects : base.sideEffects,
    reportSpec: patch.reportSpec !== undefined ? patch.reportSpec : base.reportSpec,
  };
}
