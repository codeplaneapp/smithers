import { describe, expect, test } from "bun:test";
import {
  DELEGATION_V2_COMPILER_VERSION,
  compileDelegationV2Program,
} from "../src/components/delegation-v2/delegationV2Compiler.js";
import {
  canonicalJson,
  invocationOutcomeNodeId,
  isGatewaySafeNodeId,
  programNodeId,
} from "../src/components/delegation-v2/delegationV2Ids.js";
import { DELEGATION_V2_REGISTRY_VERSION } from "../src/components/delegation-v2/delegationV2Schemas.ts";
import { delegationV2ProgramDigest } from "../src/components/delegation-v2/delegationV2Validate.js";

const goal = {
  objective: "Produce the requested result with evidence.",
  context: [],
  constraints: ["Stay inside the assigned scope."],
  nonGoals: [],
};

/**
 * @param {string} id
 * @param {Partial<Record<string, any>>} [overrides]
 */
function agent(id, overrides = {}) {
  return {
    tag: "agent",
    id,
    role: "luna",
    work: "research",
    goal,
    prompt: { instructions: `Investigate ${id}.`, contextRefs: [] },
    inputs: [],
    acceptance: [{ id: `${id}-criterion`, requirement: `Prove ${id}.`, verification: "Cite direct evidence." }],
    outputContract: "evidence_collection",
    ...overrides,
  };
}

/** @param {Record<string, any>} root @param {Record<string, any>[]} outputs */
function program(root, outputs) {
  return {
    schemaVersion: 1,
    registryVersion: DELEGATION_V2_REGISTRY_VERSION,
    id: "fragment",
    objective: goal,
    rationale: "Use the smallest topology that proves the goal.",
    root,
    outputs,
  };
}

/**
 * @param {Record<string, any>} value
 * @param {Partial<Record<string, any>>} [overrides]
 */
function compile(value, overrides = {}) {
  return compileDelegationV2Program({
    program: value,
    invocationKey: "trellis:root",
    authorNodeId: "trellis:turn:author",
    generation: 2,
    programDigest: delegationV2ProgramDigest(value),
    rootMaxConcurrency: 4,
    ...overrides,
  });
}

describe("delegation v2 pure compiler", () => {
  test("pre-indexes one worker into immutable raw and canonical outcome ids", () => {
    const value = program(agent("inspect"), [{ from: "inspect", contract: "evidence_collection" }]);
    const plan = compile(value);
    const leaf = plan.root;

    expect(plan.compilerVersion).toBe(DELEGATION_V2_COMPILER_VERSION);
    expect(plan.authorNodeId).toBe("trellis:turn:author");
    expect(leaf.kind).toBe("agent");
    expect(leaf.nestedAuthor).toBe(false);
    expect(leaf.rawNodeId).toBe(
      programNodeId({
        invocationKey: "trellis:root",
        generation: 2,
        programDigest: plan.programDigest,
        localId: "inspect",
        phase: "worker",
      }),
    );
    expect(leaf.outcomeNodeId).toBe(
      programNodeId({
        invocationKey: "trellis:root",
        generation: 2,
        programDigest: plan.programDigest,
        localId: "inspect",
        phase: "outcome",
      }),
    );
    expect(leaf.settlementDependsOn).toEqual([leaf.rawNodeId]);
    expect(plan.declaredOutputs).toEqual([
      { from: "inspect", contract: "evidence_collection", outcomeNodeId: leaf.outcomeNodeId },
    ]);
    expect(plan.declaredOutputNodeIds).toEqual([leaf.outcomeNodeId]);
    expect(plan.completionOutcomeNodeIds).toEqual([leaf.outcomeNodeId]);
    expect(plan.nodeIndex).toHaveLength(1);
    expect(isGatewaySafeNodeId(leaf.rawNodeId)).toBe(true);
    expect(isGatewaySafeNodeId(leaf.outcomeNodeId)).toBe(true);
    expect(canonicalJson(plan)).toBe(canonicalJson(compile(value)));
  });

  test("wires sequence barriers and declared inputs through canonical outcomes", () => {
    const inspect = agent("inspect");
    const synthesize = agent("synthesize", {
      role: "terra",
      work: "synthesize",
      prompt: { instructions: "Reconcile the inspected evidence.", contextRefs: ["inspect"] },
      inputs: [{ from: "inspect", contract: "evidence_collection", purpose: "Source evidence to reconcile." }],
      outputContract: "work_product",
    });
    const value = program({ tag: "sequence", id: "pipeline", steps: [inspect, synthesize] }, [
      { from: "synthesize", contract: "work_product" },
    ]);
    const plan = compile(value, { entryDependsOn: ["trellis:validation:accepted"] });
    const [first, second] = plan.root.steps;

    expect(first.dependsOn).toEqual(["trellis:validation:accepted"]);
    expect(second.sequenceDependencyNodeIds).toEqual([first.outcomeNodeId]);
    expect(second.inputOutcomeNodeIds).toEqual([first.outcomeNodeId]);
    expect(second.dependsOn).toEqual([first.outcomeNodeId]);
    expect(second.inputBindings).toEqual([
      {
        from: "inspect",
        contract: "evidence_collection",
        purpose: "Source evidence to reconcile.",
        outcomeNodeId: first.outcomeNodeId,
      },
    ]);
    expect(plan.root.completionOutcomeNodeIds).toEqual([second.outcomeNodeId]);
    expect(plan.completionOutcomeNodeIds).toEqual([second.outcomeNodeId]);
  });

  test("fans out from one entry barrier and rejects a local width above the trusted cap", () => {
    const branches = ["one", "two", "three", "four"].map((id) => agent(id));
    const value = program(
      { tag: "parallel", id: "wave", branches, maxConcurrency: 2 },
      branches.map((branch) => ({ from: branch.id, contract: "evidence_collection" })),
    );
    const plan = compile(value, {
      rootMaxConcurrency: 2,
      entryDependsOn: ["trellis:validation:accepted"],
    });

    expect(plan.root.requestedMaxConcurrency).toBe(2);
    expect(plan.root.maxConcurrency).toBe(2);
    expect(plan.root.clamped).toBe(false);
    expect(
      plan.root.branches.every(
        (branch) => canonicalJson(branch.dependsOn) === canonicalJson(["trellis:validation:accepted"]),
      ),
    ).toBe(true);
    expect(plan.root.completionOutcomeNodeIds).toEqual(plan.root.branches.map((branch) => branch.outcomeNodeId));
    const oversized = program(
      { tag: "parallel", id: "wave", branches, maxConcurrency: 4 },
      branches.map((branch) => ({ from: branch.id, contract: "evidence_collection" })),
    );
    expect(() => compile(oversized, { rootMaxConcurrency: 2 })).toThrow("accepted delegation v2 program");
  });

  test("marks Sol/Fable leaves as nested invocations with invocation-owned outcomes", () => {
    const nested = agent("architect", {
      role: "sol",
      work: "synthesize",
      outputContract: "work_product",
      prompt: { instructions: "Author the bounded corrective fragment.", contextRefs: [] },
    });
    const value = program(nested, [{ from: "architect", contract: "work_product" }]);
    const plan = compile(value);
    const leaf = plan.root;
    const expectedInvocationKey = programNodeId({
      invocationKey: "trellis:root",
      generation: 2,
      programDigest: plan.programDigest,
      localId: "architect",
      phase: "invoke",
    });

    expect(leaf.nestedAuthor).toBe(true);
    expect(leaf.rawNodeId).toBeNull();
    expect(leaf.nestedInvocationKey).toBe(expectedInvocationKey);
    expect(leaf.physicalNodeId).toBe(expectedInvocationKey);
    expect(leaf.outcomeNodeId).toBe(invocationOutcomeNodeId({ invocationKey: expectedInvocationKey }));
    expect(leaf.settlementDependsOn).toEqual([]);
  });

  test("propagates trusted capped-Parallel ancestry into recursive author invocations", () => {
    const architect = agent("architect", {
      role: "fable",
      work: "plan",
      outputContract: "plan",
    });
    const inspect = agent("inspect");
    const value = program(
      {
        tag: "parallel",
        id: "bounded-wave",
        maxConcurrency: 2,
        branches: [architect, inspect],
      },
      [
        { from: "architect", contract: "plan" },
        { from: "inspect", contract: "evidence_collection" },
      ],
    );
    const plan = compile(value, { rootMaxConcurrency: 2 });
    expect(plan.root.branches[0].hasCappedParallelAncestor).toBe(true);
    expect(plan.root.branches[1].hasCappedParallelAncestor).toBe(true);
    expect(() =>
      compile(
        program(
          {
            tag: "parallel",
            id: "recursive-wave",
            maxConcurrency: 2,
            branches: [agent("one"), agent("two")],
          },
          [
            { from: "one", contract: "evidence_collection" },
            { from: "two", contract: "evidence_collection" },
          ],
        ),
        {
          rootMaxConcurrency: 2,
          hasCappedParallelAncestor: true,
        },
      ),
    ).toThrow("unsupported_nested_concurrency");
  });

  test("binds exceptional high-tier execution to the exact compiled actor and trusted policy", () => {
    const execute = agent("critical-core", {
      role: "sol",
      work: "execute",
      outputContract: "work_product",
      criticality: {
        category: "protocol_core",
        invariant: "Protocol frames remain deterministic.",
        whyHighTierIsRequired: "Every changed branch affects replay identity.",
        whyTheCoreCannotBeDelegated: "Splitting the identity proof would lose whole-frame context.",
        allowedPaths: ["packages/engine/src/protocol.js"],
        expectedChangedLines: 18,
        lineSensitivity: "Each line participates in canonical frame construction.",
        surroundingWorkDelegatedTo: [],
        reviewNodeId: "critical-review",
      },
    });
    const review = agent("critical-review", {
      work: "review",
      outputContract: "evaluation",
      inputs: [{ from: "critical-core", contract: "work_product", purpose: "Review the critical core." }],
      prompt: { instructions: "Independently review the protocol invariant.", contextRefs: ["critical-core"] },
    });
    const value = program({ tag: "sequence", id: "critical-flow", steps: [execute, review] }, [
      { from: "critical-review", contract: "evaluation" },
    ]);
    const criticalExecutionPolicy = {
      allowedCategories: ["protocol_core"],
      allowedPathPrefixes: ["packages/engine/src"],
      maxChangedLines: 30,
    };
    expect(() => compile(value)).toThrow("accepted delegation v2 program");
    expect(() =>
      compile(value, {
        criticalExecutionPolicy,
        criticalReviewIndependentRoles: { sol: ["fable"], fable: ["sol", "terra", "luna"] },
      }),
    ).toThrow("critical_review_not_independent");
    const plan = compile(value, {
      criticalExecutionPolicy,
      criticalReviewIndependentRoles: { sol: ["fable", "terra", "luna"], fable: ["sol", "terra", "luna"] },
    });
    expect(plan.criticalReviewIndependentRoles.sol).toContain("luna");
    const leaf = plan.root.steps[0];
    expect(leaf.criticalExecutionGrant).toMatchObject({
      policyVersion: "delegation-v2.critical-execution/1",
      allowedPaths: ["packages/engine/src/protocol.js"],
      expectedChangedLines: 18,
      reviewer: {
        logicalId: "critical-review",
        role: "luna",
        work: "review",
        outcomeNodeId: plan.root.steps[1].outcomeNodeId,
      },
      actor: {
        invocationKey: leaf.nestedInvocationKey,
        programId: value.id,
        programDigest: plan.programDigest,
        logicalId: "critical-core",
        role: "sol",
        work: "execute",
      },
      grantHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  test("carries stable author and container lineage without array-position identity", () => {
    const value = program(
      {
        tag: "sequence",
        id: "outer",
        steps: [{ tag: "parallel", id: "inner", branches: [agent("left"), agent("right")] }],
      },
      [{ from: "right", contract: "evidence_collection" }],
    );
    const plan = compile(value, { authorLineage: ["trellis:ancestor"] });
    const right = plan.nodeIndex.find((entry) => entry.logicalId === "right");

    expect(plan.authorLineage).toEqual(["trellis:ancestor", "trellis:root"]);
    expect(plan.root.steps[0].requestedMaxConcurrency).toBeNull();
    expect(plan.root.steps[0].maxConcurrency).toBeNull();
    expect(right.source.authorLineage).toEqual(plan.authorLineage);
    expect(right.source.authorNodeId).toBe("trellis:turn:author");
    expect(right.source.containerLineage).toEqual(["outer", "inner"]);
    expect(right.source.parentLogicalId).toBe("inner");
    expect(right.source.programDigest).toBe(plan.programDigest);
  });

  test("treats Parallel sibling order as semantic noise while preserving Sequence order", () => {
    const left = agent("left");
    const right = agent("right");
    const parallelA = program({ tag: "parallel", id: "wave", branches: [right, left] }, [
      { from: "right", contract: "evidence_collection" },
      { from: "left", contract: "evidence_collection" },
    ]);
    const parallelB = program({ tag: "parallel", id: "wave", branches: [left, right] }, [
      { from: "left", contract: "evidence_collection" },
      { from: "right", contract: "evidence_collection" },
    ]);
    expect(delegationV2ProgramDigest(parallelA)).toBe(delegationV2ProgramDigest(parallelB));
    const idsA = compile(parallelA)
      .nodeIndex.map((node) => [node.logicalId, node.physicalNodeId])
      .sort();
    const idsB = compile(parallelB)
      .nodeIndex.map((node) => [node.logicalId, node.physicalNodeId])
      .sort();
    expect(idsA).toEqual(idsB);

    const sequenceA = program({ tag: "sequence", id: "flow", steps: [left, right] }, [
      { from: "right", contract: "evidence_collection" },
    ]);
    const sequenceB = program({ tag: "sequence", id: "flow", steps: [right, left] }, [
      { from: "left", contract: "evidence_collection" },
    ]);
    expect(delegationV2ProgramDigest(sequenceA)).not.toBe(delegationV2ProgramDigest(sequenceB));
  });

  test("rejects stale digests, executable fields, and incompatible references", () => {
    const direct = program(agent("inspect"), [{ from: "inspect", contract: "evidence_collection" }]);
    expect(() =>
      compileDelegationV2Program({
        program: direct,
        invocationKey: "trellis:root",
        authorNodeId: "trellis:turn:author",
        generation: 0,
        programDigest: "0".repeat(64),
        rootMaxConcurrency: 1,
      }),
    ).toThrow(/programDigest/);

    const executable = structuredClone(direct);
    executable.root.callback = () => "not data";
    expect(() => compile(executable)).toThrow();

    const mismatch = program(
      {
        tag: "sequence",
        id: "pipeline",
        steps: [
          agent("source"),
          agent("consumer", {
            inputs: [{ from: "source", contract: "work_product", purpose: "Wrong contract." }],
          }),
        ],
      },
      [{ from: "consumer", contract: "evidence_collection" }],
    );
    expect(() => compile(mismatch)).toThrow(/contract/);
  });
});
