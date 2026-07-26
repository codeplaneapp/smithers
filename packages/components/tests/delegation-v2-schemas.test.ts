import { describe, expect, test } from "bun:test";
import {
  authorEnvelopeSchema,
  authorEnvelopeSchemaFor,
  capturedWorkflowProgramSchema,
  DELEGATION_V2_AUTHOR_CAPTURE_LIMITS,
  delegationV2Schemas,
  dv2OutcomeSchema,
  dv2QuestionSchema,
  workerEnvelopeSchema,
  workerEnvelopeSchemaFor,
  workflowProgramSchema,
} from "../src/components/delegation-v2/delegationV2Schemas.ts";

const goal = {
  objective: "Establish the behavior with evidence.",
  context: [],
  constraints: ["Do not mutate the workspace."],
  nonGoals: [],
};

const researchProduct = {
  work: "research" as const,
  summary: "The evidence supports the conclusion.",
  acceptance: [
    { criterionId: "answer", status: "passed" as const, evidenceIds: ["source"], explanation: "Source is direct." },
  ],
  evidence: [{ id: "source", kind: "source" as const, summary: "Primary documentation." }],
  artifacts: [],
  assumptions: [],
  openRisks: [],
  details: { conclusion: "Supported.", findings: ["The documented behavior is explicit."] },
};

const directProgram = {
  schemaVersion: 1 as const,
  registryVersion: "core-1",
  id: "program",
  objective: goal,
  rationale: "One closed research task is sufficient.",
  root: {
    tag: "agent" as const,
    id: "research",
    role: "luna" as const,
    work: "research" as const,
    goal,
    prompt: { instructions: "Find the authoritative answer.", contextRefs: [] },
    inputs: [],
    acceptance: [{ id: "answer", requirement: "Answer the question.", verification: "Cite primary evidence." }],
    outputContract: "work_product" as const,
  },
  outputs: [{ from: "research", contract: "work_product" as const }],
};

describe("delegation v2 schemas", () => {
  test("accepts the three direct IR tags and rejects unknown fields at every boundary", () => {
    expect(workflowProgramSchema.safeParse(directProgram).success).toBe(true);
    expect(workflowProgramSchema.safeParse({ ...directProgram, injected: true }).success).toBe(false);
    expect(
      workflowProgramSchema.safeParse({
        ...directProgram,
        root: { ...directProgram.root, injected: "tool authority" },
      }).success,
    ).toBe(false);

    const sequence = {
      ...directProgram,
      root: { tag: "sequence", id: "pipeline", steps: [directProgram.root] },
    };
    const parallel = {
      ...directProgram,
      root: {
        tag: "parallel",
        id: "panel",
        branches: [directProgram.root, { ...directProgram.root, id: "research-two" }],
        maxConcurrency: 2,
      },
    };
    expect(workflowProgramSchema.safeParse(sequence).success).toBe(true);
    expect(workflowProgramSchema.safeParse(parallel).success).toBe(true);
    expect(workflowProgramSchema.safeParse({ ...directProgram, root: { tag: "shell", id: "escape" } }).success).toBe(
      false,
    );
  });

  test("author envelopes can grow the graph while worker envelopes cannot represent delegation", () => {
    const author = {
      protocolVersion: 2,
      outcome: { tag: "subworkflow", value: directProgram },
      state: { summary: "Delegated the closed task.", retainedFacts: [], openRisks: [] },
    };
    expect(authorEnvelopeSchema.safeParse(author).success).toBe(true);
    expect(authorEnvelopeSchemaFor("research").safeParse(author).success).toBe(true);
    expect(workerEnvelopeSchema.safeParse({ protocolVersion: 2, outcome: author.outcome }).success).toBe(false);
  });

  test("captures malformed authored IR for trusted validation while bounding the raw JSON transport", () => {
    const state = { summary: "Repair the proposed fragment.", retainedFacts: [], openRisks: [] };
    const envelope = (value: unknown) => ({
      protocolVersion: 2,
      outcome: { tag: "subworkflow", value },
      state,
    });
    const extraKey = { ...directProgram, root: { ...directProgram.root, injectedTool: "shell" } };
    const malformedTag = { ...directProgram, root: { ...directProgram.root, tag: "agnet" } };
    let overSemanticDepth: unknown = directProgram.root;
    for (let index = 0; index < 12; index += 1) {
      overSemanticDepth = { tag: "sequence", id: `deep-${index}`, steps: [overSemanticDepth] };
    }
    const deepProgram = { ...directProgram, root: overSemanticDepth };

    for (const raw of [extraKey, malformedTag, deepProgram]) {
      expect(workflowProgramSchema.safeParse(raw).success).toBe(raw === deepProgram);
      expect(authorEnvelopeSchemaFor("research").safeParse(envelope(raw)).success).toBe(true);
    }
    expect(
      authorEnvelopeSchemaFor("research").safeParse({ ...envelope(extraKey), ambientAuthority: true }).success,
    ).toBe(false);

    const cyclic: Record<string, unknown> = { ...directProgram };
    cyclic.self = cyclic;
    expect(capturedWorkflowProgramSchema.safeParse(cyclic).success).toBe(false);
    expect(capturedWorkflowProgramSchema.safeParse({ ...directProgram, executable: () => undefined }).success).toBe(
      false,
    );
    expect(
      capturedWorkflowProgramSchema.safeParse({
        ...directProgram,
        values: Array(DELEGATION_V2_AUTHOR_CAPTURE_LIMITS.maxArrayLength + 1).fill(null),
      }).success,
    ).toBe(false);

    let hostile: unknown = { leaf: true };
    for (let index = 0; index <= DELEGATION_V2_AUTHOR_CAPTURE_LIMITS.maxDepth; index += 1) hostile = { child: hostile };
    expect(capturedWorkflowProgramSchema.safeParse(hostile).success).toBe(false);
  });

  test("work-specific builders prevent a worker from changing its assigned playbook", () => {
    const complete = { protocolVersion: 2, outcome: { tag: "complete", value: researchProduct } };
    expect(workerEnvelopeSchemaFor("research").safeParse(complete).success).toBe(true);
    expect(workerEnvelopeSchemaFor("review").safeParse(complete).success).toBe(false);
    expect(
      authorEnvelopeSchemaFor("research").safeParse({
        ...complete,
        state: { summary: "Done.", retainedFacts: [], openRisks: [] },
      }).success,
    ).toBe(true);
  });

  test("blocked work requires attempted alternatives and an explicit no-fallback explanation", () => {
    const base = {
      work: "research",
      summary: "Access was unavailable.",
      partialWork: "Inspected all local evidence.",
      attemptedAlternatives: ["Searched the local documentation."],
      whyNoSafeFallbackExists: "Any conclusion would be fabricated.",
      requiredNextAction: "Provide the referenced private document.",
      evidence: [],
      openRisks: [],
    };
    expect(
      workerEnvelopeSchemaFor("research").safeParse({ protocolVersion: 2, outcome: { tag: "blocked", value: base } })
        .success,
    ).toBe(true);
    expect(
      workerEnvelopeSchemaFor("research").safeParse({
        protocolVersion: 2,
        outcome: { tag: "blocked", value: { ...base, attemptedAlternatives: [] } },
      }).success,
    ).toBe(false);
  });

  test("question and trusted row schemas are strict and bounded", () => {
    const question = {
      key: "api-choice",
      target: "human",
      question: "Which public API should remain stable?",
      whyItMatters: "The choice changes compatibility.",
      fallbackAssumption: "Preserve both APIs.",
      impactIfWrong: "There may be an unnecessary compatibility alias.",
    };
    expect(dv2QuestionSchema.safeParse(question).success).toBe(true);
    expect(dv2QuestionSchema.safeParse({ ...question, waitForAnswer: true }).success).toBe(false);

    const outcome = {
      invocationKey: "root",
      logicalId: "research",
      generation: 0,
      role: "luna",
      work: "research",
      outputContract: "evidence_collection",
      assignmentDigest: "0".repeat(64),
      acceptanceCriterionIds: ["answer"],
      status: "complete",
      sourceNodeId: "trellis:node:research:raw:0123456789abcdef01234567",
      product: researchProduct,
    };
    expect(dv2OutcomeSchema.safeParse(outcome).success).toBe(true);
    expect(dv2OutcomeSchema.safeParse({ ...outcome, untrustedAgent: "shell" }).success).toBe(false);
    expect(dv2OutcomeSchema.safeParse({ ...outcome, status: "blocked" }).success).toBe(false);
    expect(dv2OutcomeSchema.safeParse({ ...outcome, work: "review" }).success).toBe(false);
    expect(Object.keys(delegationV2Schemas)).toEqual([
      "dv2Author",
      "dv2Worker",
      "dv2Validation",
      "dv2Outcome",
      "dv2Final",
      "dv2Question",
      "dv2Answer",
    ]);
  });
});
