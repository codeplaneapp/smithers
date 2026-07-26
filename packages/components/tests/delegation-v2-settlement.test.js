import { describe, expect, test } from "bun:test";
import { settleDelegationV2Envelope } from "../src/components/delegation-v2/delegationV2Settlement.js";
import {
  bindCriticalExecutionGrant,
  deriveCriticalExecutionGrant,
  normalizeCriticalExecutionPolicy,
} from "../src/components/delegation-v2/delegationV2CriticalExecution.js";

const goal = {
  objective: "Establish the assigned claim.",
  context: [],
  constraints: [],
  nonGoals: [],
};
const criterion = { id: "answer", requirement: "Answer the question.", verification: "Inspect direct evidence." };
const identity = {
  invocationKey: "trellis:root:0123456789abcdef01234567",
  logicalId: "research",
  generation: 0,
  sourceNodeId: "trellis:node:research:worker:0123456789abcdef01234567",
};

function assignment(overrides = {}) {
  return {
    role: "luna",
    work: "research",
    outputContract: "evidence_collection",
    goal,
    instructions: "Find the direct source.",
    acceptance: [criterion],
    criticality: null,
    directExecutionAllowed: false,
    ...overrides,
  };
}

function researchProduct(overrides = {}) {
  return {
    work: "research",
    summary: "The source establishes the answer.",
    acceptance: [
      { criterionId: "answer", status: "passed", evidenceIds: ["proof"], explanation: "The source is direct." },
    ],
    evidence: [{ id: "proof", kind: "source", summary: "Primary source." }],
    artifacts: [],
    assumptions: [],
    openRisks: [],
    details: { conclusion: "Established.", findings: ["The source is explicit."] },
    ...overrides,
  };
}

function settleComplete(product = researchProduct(), assignmentValue = assignment()) {
  return settleDelegationV2Envelope({
    envelope: { protocolVersion: 2, outcome: { tag: "complete", value: product } },
    assignment: assignmentValue,
    identity,
  });
}

describe("delegation v2 assignment-aware settlement", () => {
  test("persists the exact nominal contract, assignment digest, and criterion coverage", () => {
    const outcome = settleComplete();
    expect(outcome.status).toBe("complete");
    expect(outcome.outputContract).toBe("evidence_collection");
    expect(outcome.acceptanceCriterionIds).toEqual(["answer"]);
    expect(outcome.assignmentDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  test("turns missing, extra, duplicate, dangling, or unproved claims into invalid_return", () => {
    const invalidProducts = [
      researchProduct({ acceptance: [] }),
      researchProduct({
        acceptance: [{ criterionId: "extra", status: "passed", evidenceIds: ["proof"], explanation: "Extra." }],
      }),
      researchProduct({
        acceptance: [
          { criterionId: "answer", status: "passed", evidenceIds: ["proof"], explanation: "First." },
          { criterionId: "answer", status: "passed", evidenceIds: ["proof"], explanation: "Second." },
        ],
      }),
      researchProduct({
        acceptance: [{ criterionId: "answer", status: "passed", evidenceIds: ["missing"], explanation: "Dangling." }],
      }),
      researchProduct({
        acceptance: [{ criterionId: "answer", status: "failed", evidenceIds: [], explanation: "No proof." }],
      }),
      researchProduct({
        acceptance: [
          { criterionId: "answer", status: "passed", evidenceIds: ["proof", "proof"], explanation: "Duplicated." },
        ],
      }),
    ];
    for (const product of invalidProducts) {
      const outcome = settleComplete(product);
      expect(outcome.status).toBe("runtime_failed");
      expect(outcome.runtimeFailure.code).toBe("invalid_return");
      expect(outcome.runtimeFailure.message.length).toBeLessThanOrEqual(2_048);
    }
  });

  test("allows an honest unknown without proof under the generic work_product contract", () => {
    const product = researchProduct({
      acceptance: [
        { criterionId: "answer", status: "unknown", evidenceIds: [], explanation: "The source is unavailable." },
      ],
      evidence: [],
    });
    expect(settleComplete(product, assignment({ outputContract: "work_product" })).status).toBe("complete");
  });

  test("requires concrete evidence/artifacts for collection contracts and one unified proof-id namespace", () => {
    expect(settleComplete(researchProduct({ evidence: [] })).status).toBe("runtime_failed");
    expect(
      settleComplete(
        researchProduct({
          artifacts: [{ id: "proof", kind: "report", locator: "report.md", summary: "Collision." }],
        }),
      ).status,
    ).toBe("runtime_failed");
  });

  test("accepts an unfavorable completed review and rejects unsupported fail/mixed verdicts", () => {
    const reviewAssignment = assignment({
      work: "review",
      outputContract: "evaluation",
      acceptance: [{ ...criterion, id: "reviewed" }],
    });
    const reviewProduct = {
      work: "review",
      summary: "The artifact does not pass review.",
      acceptance: [
        {
          criterionId: "reviewed",
          status: "passed",
          evidenceIds: ["finding"],
          explanation: "The review was completed.",
        },
      ],
      evidence: [{ id: "finding", kind: "observation", summary: "A concrete defect was reproduced." }],
      artifacts: [],
      assumptions: [],
      openRisks: [],
      details: { verdict: "fail", findings: ["The invariant is violated."] },
    };
    expect(settleComplete(reviewProduct, reviewAssignment).status).toBe("complete");
    expect(
      settleComplete({ ...reviewProduct, details: { verdict: "mixed", findings: [] } }, reviewAssignment).status,
    ).toBe("runtime_failed");
  });

  test("rejects duplicate blocked evidence and throws only for malformed trusted input", () => {
    const blockage = {
      work: "research",
      summary: "The required private source is unavailable.",
      partialWork: "Inspected all available local sources.",
      attemptedAlternatives: ["Searched the repository."],
      whyNoSafeFallbackExists: "Any answer would be fabricated.",
      requiredNextAction: "Provide the private source.",
      evidence: [
        { id: "search", kind: "observation", summary: "No local source exists." },
        { id: "search", kind: "observation", summary: "Duplicate id." },
      ],
      openRisks: [],
    };
    const blocked = settleDelegationV2Envelope({
      envelope: { protocolVersion: 2, outcome: { tag: "blocked", value: blockage } },
      assignment: assignment(),
      identity,
    });
    expect(blocked.runtimeFailure.code).toBe("invalid_return");
    expect(() =>
      settleDelegationV2Envelope({
        envelope: undefined,
        assignment: assignment({ acceptance: [criterion, criterion] }),
        identity,
        taskFailure: { code: "crash", message: "failed" },
      }),
    ).toThrow(/acceptance ids/);
  });

  test("refuses Sol/Fable execute completion unless its trusted grant matches the immutable actor", () => {
    const criticality = {
      category: "protocol_core",
      invariant: "Canonical frames replay identically.",
      whyHighTierIsRequired: "Every changed branch affects durable identity.",
      whyTheCoreCannotBeDelegated: "Splitting the proof loses frame-level context.",
      allowedPaths: ["packages/engine/src/protocol.js"],
      expectedChangedLines: 12,
      lineSensitivity: "Every line participates in canonical encoding.",
      surroundingWorkDelegatedTo: [],
      reviewNodeId: "critical-review",
    };
    const policy = normalizeCriticalExecutionPolicy({
      allowedCategories: ["protocol_core"],
      allowedPathPrefixes: ["packages/engine/src"],
      maxChangedLines: 20,
    });
    const admitted = deriveCriticalExecutionGrant(criticality, policy);
    const criticalIdentity = {
      invocationKey: "trellis:invoke:0123456789abcdef01234567",
      logicalId: "critical-core",
      generation: 0,
      sourceNodeId: "trellis:author:0123456789abcdef01234567",
      programDigest: "a".repeat(64),
    };
    const grant = bindCriticalExecutionGrant(admitted.grant, {
      invocationKey: criticalIdentity.invocationKey,
      programId: "critical-program",
      programDigest: criticalIdentity.programDigest,
      logicalId: criticalIdentity.logicalId,
      role: "sol",
      work: "execute",
    });
    const executeAssignment = assignment({
      role: "sol",
      work: "execute",
      outputContract: "work_product",
      criticality,
    });
    const executeProduct = {
      work: "execute",
      summary: "The bounded protocol core was changed.",
      acceptance: [
        { criterionId: "answer", status: "passed", evidenceIds: ["test"], explanation: "The protocol test passed." },
      ],
      evidence: [{ id: "test", kind: "test", summary: "Protocol replay passed." }],
      artifacts: [{ id: "change", kind: "diff", locator: "packages/engine/src/protocol.js", summary: "Bounded diff." }],
      assumptions: [],
      openRisks: [],
      details: { result: "Updated canonical encoding.", verification: ["Protocol replay test passed."] },
    };
    const envelope = { protocolVersion: 2, outcome: { tag: "complete", value: executeProduct } };
    expect(
      settleDelegationV2Envelope({ envelope, assignment: executeAssignment, identity: criticalIdentity }).status,
    ).toBe("runtime_failed");
    expect(
      settleDelegationV2Envelope({
        envelope,
        assignment: { ...executeAssignment, criticalExecutionGrant: grant },
        identity: criticalIdentity,
      }).status,
    ).toBe("complete");
    expect(
      settleDelegationV2Envelope({
        envelope,
        assignment: { ...executeAssignment, criticalExecutionGrant: grant },
        identity: { ...criticalIdentity, invocationKey: "trellis:invoke:other" },
      }).status,
    ).toBe("runtime_failed");
  });
});
