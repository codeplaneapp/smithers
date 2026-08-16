/** @jsxImportSource smthrs */
import { describe, expect, test } from "bun:test";
import { MemoryTrellis as PackageMemoryTrellis } from "@smthrs/components";
import { MemoryTrellis } from "../src/components/index.js";
import { createSmithers, MemoryTrellis as FacadeMemoryTrellis } from "smthrs";
import { renderWorkflow } from "smthrs/testing";
import {
  DELEGATION_V2_REGISTRY_VERSION,
  delegationV2Schemas,
} from "../src/components/delegation-v2/delegationV2Schemas.ts";
import {
  compileDelegationV2Program,
  DELEGATION_V2_COMPILER_VERSION,
} from "../src/components/delegation-v2/delegationV2Compiler.js";
import {
  delegationV2ProgramDigest,
  validateWorkflowProgram,
} from "../src/components/delegation-v2/delegationV2Validate.js";
import { turnNodeId } from "../src/components/delegation-v2/delegationV2Ids.js";

const goal = {
  objective: "Produce a verified answer.",
  context: [],
  constraints: ["Use the smallest sufficient graph."],
  nonGoals: [],
};

const criterion = {
  id: "done",
  requirement: "Produce a verified answer.",
  verification: "Inspect the returned evidence.",
};

const agents = Object.fromEntries(
  ["sol", "fable", "terra", "luna"].map((role) => [
    role,
    { id: `memory-trellis-${role}`, tools: {}, generate: async () => ({ output: {} }) },
  ]),
);

const memory = {
  bank: "project-memory-trellis",
  tags: ["experiment:learn"],
  recall: "auto",
  budget: "high",
  maxTokens: 900,
  primers: ["project-primer"],
  retain: "on-complete",
  tools: true,
};

const normalizedMemory = memory;
const { Workflow, smithers, outputs } = createSmithers(delegationV2Schemas);
const workflow = smithers(() => (
  <Workflow name="memory-trellis">
    <MemoryTrellis
      memory={memory}
      prompt="Produce a verified answer."
      goal={goal}
      acceptance={[criterion]}
      agents={agents}
      outputs={outputs}
      maxConcurrency={2}
    />
  </Workflow>
));

function product(work, summary) {
  return {
    work,
    summary,
    acceptance: [
      {
        criterionId: "done",
        status: "passed",
        evidenceIds: ["proof"],
        explanation: "Direct evidence proves the criterion.",
      },
    ],
    evidence: [{ id: "proof", kind: "test", summary: "A deterministic test completed successfully." }],
    artifacts: [],
    assumptions: [],
    openRisks: [],
    details:
      work === "research"
        ? { conclusion: summary, findings: ["The evidence supports the conclusion."] }
        : { conclusion: summary, disagreements: [] },
  };
}

function subworkflowEnvelope(value) {
  return {
    protocolVersion: 2,
    outcome: { tag: "subworkflow", value },
    state: { summary: "A bounded fragment is in flight.", retainedFacts: [], openRisks: [] },
  };
}

function workerEnvelope(summary) {
  return { protocolVersion: 2, outcome: { tag: "complete", value: product("research", summary) } };
}

function completeEnvelope(summary) {
  return {
    protocolVersion: 2,
    outcome: { tag: "complete", value: product("synthesize", summary) },
    state: { summary, retainedFacts: [], openRisks: [] },
  };
}

function program() {
  return {
    schemaVersion: 1,
    registryVersion: DELEGATION_V2_REGISTRY_VERSION,
    id: "memory-fragment",
    objective: goal,
    rationale: "One worker provides the required evidence.",
    root: {
      tag: "agent",
      id: "inspect",
      role: "luna",
      work: "research",
      goal,
      prompt: { instructions: "Inspect the evidence.", contextRefs: [] },
      inputs: [],
      acceptance: [criterion],
      outputContract: "evidence_collection",
    },
    outputs: [{ from: "inspect", contract: "evidence_collection" }],
  };
}

async function render(rows = {}) {
  return renderWorkflow(workflow, {
    runId: "memory-trellis-render",
    input: {},
    outputs: rows,
    runtimeConfig: {
      requireRerenderOnOutputChange: true,
      maxConcurrencyPinned: true,
      maxConcurrency: 2,
    },
  });
}

function expectSharedPolicy(frame) {
  expect(frame.tasks.length).toBeGreaterThan(0);
  for (const task of frame.tasks) expect(task.memoryConfig).toEqual(normalizedMemory);
}

describe("MemoryTrellis", () => {
  test("is exported from components and the smithers facade", () => {
    expect(typeof MemoryTrellis).toBe("function");
    expect(PackageMemoryTrellis).toBe(MemoryTrellis);
    expect(FacadeMemoryTrellis).toBe(MemoryTrellis);
  });

  test("applies one policy to initial, worker retry, settlement, continuation, and final tasks", async () => {
    const authored = program();
    const initial = await render();
    expectSharedPolicy(initial);
    const initialAuthor = initial.tasks.find((task) => task.meta?.trellis?.phase === "initial");
    const invocationKey = initialAuthor.meta.trellis.invocationKey;
    const authorId = turnNodeId({ invocationKey, generation: 0, phase: "author" });
    const validationId = turnNodeId({ invocationKey, generation: 0, phase: "validate" });
    const authorRow = { nodeId: authorId, iteration: 0, ...subworkflowEnvelope(authored) };

    const afterAuthor = await render({ dv2Author: [authorRow] });
    expectSharedPolicy(afterAuthor);
    expect(afterAuthor.tasks.map((task) => [task.nodeId, task.meta?.trellis?.phase])).toContainEqual([
      validationId,
      "validation",
    ]);

    const validation = validateWorkflowProgram(authored, { rootMaxConcurrency: 2 });
    expect(validation.ok).toBe(true);
    const digest = delegationV2ProgramDigest(authored);
    const accepted = {
      nodeId: validationId,
      iteration: 0,
      invocationKey,
      generation: 0,
      authorNodeId: authorId,
      status: "accepted",
      programDigest: digest,
      registryVersion: DELEGATION_V2_REGISTRY_VERSION,
      compilerVersion: DELEGATION_V2_COMPILER_VERSION,
      normalizedProgram: authored,
      diagnostics: [],
      stats: validation.stats,
    };
    const plan = compileDelegationV2Program({
      program: authored,
      invocationKey,
      authorNodeId: authorId,
      generation: 0,
      programDigest: digest,
      rootMaxConcurrency: 2,
      entryDependsOn: [validationId],
    });
    const baseRows = { dv2Author: [authorRow], dv2Validation: [accepted] };
    const afterValidation = await render(baseRows);
    expectSharedPolicy(afterValidation);
    const worker = afterValidation.tasks.find((task) => task.meta?.trellis?.phase === "worker");
    expect(worker.retries).toBe(1);

    const workerRow = {
      nodeId: plan.root.rawNodeId,
      iteration: 0,
      ...workerEnvelope("The requested evidence was collected."),
    };
    const afterWorker = await render({ ...baseRows, dv2Worker: [workerRow] });
    expectSharedPolicy(afterWorker);
    const workerOutcome = afterWorker.tasks.find(
      (task) => task.meta?.trellis?.phase === "outcome" && task.meta?.trellis?.logicalId === "inspect",
    );
    expect(workerOutcome.staticPayload).toBeDefined();
    const settledWorkerRow = {
      nodeId: plan.root.outcomeNodeId,
      iteration: 0,
      ...workerOutcome.staticPayload,
    };

    const settledRows = { ...baseRows, dv2Worker: [workerRow], dv2Outcome: [settledWorkerRow] };
    const afterSettlement = await render(settledRows);
    expectSharedPolicy(afterSettlement);
    const continuation = afterSettlement.tasks.find((task) => task.meta?.trellis?.phase === "continuation");
    expect(continuation).toBeDefined();

    const continuationRow = {
      nodeId: continuation.nodeId,
      iteration: 0,
      ...completeEnvelope("The worker evidence proves the root goal."),
    };
    const afterContinuation = await render({
      ...settledRows,
      dv2Author: [authorRow, continuationRow],
    });
    expectSharedPolicy(afterContinuation);
    const rootOutcome = afterContinuation.tasks.find(
      (task) => task.meta?.trellis?.phase === "outcome" && task.meta?.trellis?.logicalId === "root",
    );
    expect(rootOutcome.staticPayload).toBeDefined();

    const finalFrame = await render({
      ...settledRows,
      dv2Author: [authorRow, continuationRow],
      dv2Outcome: [settledWorkerRow, { nodeId: rootOutcome.nodeId, iteration: 0, ...rootOutcome.staticPayload }],
    });
    expectSharedPolicy(finalFrame);
    expect(finalFrame.tasks.some((task) => task.meta?.trellis?.phase === "final")).toBe(true);
  });
});
