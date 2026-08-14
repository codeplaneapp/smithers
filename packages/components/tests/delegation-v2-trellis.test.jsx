/** @jsxImportSource smthrs */
import { describe, expect, test } from "bun:test";
import React from "react";
import { Effect } from "effect";
import { runWorkflow } from "smthrs";
import { SmithersRenderer } from "@smthrs/react-reconciler/dom/renderer";
import { SmithersContext, SmithersCtx } from "@smthrs/react-reconciler/context";
import { createTestSmithers } from "./helpers.js";
import { Trellis, validateDelegationV2RepairIntegrity } from "../src/components/delegation-v2/Trellis.js";
import {
  DELEGATION_V2_REGISTRY_VERSION,
  delegationV2Schemas,
} from "../src/components/delegation-v2/delegationV2Schemas.ts";
import { turnNodeId } from "../src/components/delegation-v2/delegationV2Ids.js";
import {
  compileDelegationV2Program,
  DELEGATION_V2_COMPILER_VERSION,
} from "../src/components/delegation-v2/delegationV2Compiler.js";
import {
  delegationV2ProgramDigest,
  validateWorkflowProgram,
} from "../src/components/delegation-v2/delegationV2Validate.js";
import { deriveCriticalReviewIndependentRoles } from "../src/components/delegation-v2/delegationV2CriticalExecution.js";

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

function product(work, summary = `${work} completed`) {
  const details = {
    refine_goal: { goal, refinedObjective: summary, unresolvedPreferences: [] },
    plan: { approach: summary, steps: ["Complete the bounded assignment."] },
    research: { conclusion: summary, findings: ["The evidence supports the conclusion."] },
    poc: { hypothesis: summary, result: "supported", observations: ["The probe succeeded."] },
    execute: { result: summary, verification: ["The implementation check passed."] },
    review: { verdict: "pass", findings: [] },
    preview: { verdict: "pass", observations: ["The preview rendered."] },
    synthesize: { conclusion: summary, disagreements: [] },
  }[work];
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
    details,
  };
}

function completeEnvelope(work, summary) {
  return {
    protocolVersion: 2,
    outcome: { tag: "complete", value: product(work, summary) },
    state: { summary: summary ?? `${work} is complete.`, retainedFacts: [], openRisks: [] },
  };
}

function workerEnvelope(work, summary) {
  return { protocolVersion: 2, outcome: { tag: "complete", value: product(work, summary) } };
}

function agentNode(id, overrides = {}) {
  return {
    tag: "agent",
    id,
    role: "luna",
    work: "research",
    goal,
    prompt: { instructions: `Investigate ${id}.`, contextRefs: [] },
    inputs: [],
    acceptance: [criterion],
    outputContract: "evidence_collection",
    ...overrides,
  };
}

function program(root, outputs) {
  return {
    schemaVersion: 1,
    registryVersion: DELEGATION_V2_REGISTRY_VERSION,
    id: "root-fragment",
    objective: goal,
    rationale: "This is the smallest graph that proves the objective.",
    root,
    outputs,
  };
}

function subworkflowEnvelope(value) {
  return {
    protocolVersion: 2,
    outcome: { tag: "subworkflow", value },
    state: { summary: "A bounded fragment is in flight.", retainedFacts: [], openRisks: [] },
  };
}

const inertAgent = { id: "inert", tools: {}, generate: async () => ({ output: completeEnvelope("synthesize") }) };
const agents = { sol: inertAgent, fable: inertAgent, terra: inertAgent, luna: inertAgent };
const outputNames = {
  dv2Author: "dv2Author",
  dv2Worker: "dv2Worker",
  dv2Validation: "dv2Validation",
  dv2Outcome: "dv2Outcome",
  dv2Final: "dv2Final",
  dv2Question: "dv2Question",
  dv2Answer: "dv2Answer",
};

const RUNTIME_TEST_TIMEOUT_MS = 120_000;

function failureText(error) {
  return [error?.message, error?.cause?.message, JSON.stringify(error), String(error)].filter(Boolean).join(" || ");
}

async function render(rows = {}, trellisProps = {}) {
  const ctx = new SmithersCtx({ runId: "trellis-render", iteration: 0, input: {}, outputs: rows });
  const renderer = new SmithersRenderer();
  return renderer.render(
    <SmithersContext.Provider value={ctx}>
      <Trellis
        prompt="Produce a verified answer."
        goal={goal}
        acceptance={[criterion]}
        agents={agents}
        outputs={outputNames}
        maxConcurrency={2}
        {...trellisProps}
      />
    </SmithersContext.Provider>,
  );
}

describe("Trellis semantic repair integrity", () => {
  test("permits only diagnosed edits and rejects whole-program replacement", () => {
    const rejected = program(agentNode("inspect", { work: "plan" }), [
      { from: "inspect", contract: "evidence_collection" },
    ]);
    const validation = validateWorkflowProgram(rejected, { rootMaxConcurrency: 2 });
    const corrected = {
      ...rejected,
      root: { ...rejected.root, work: "research" },
      supersedes: { id: rejected.id, digest: validation.programDigest },
    };
    expect(
      validateDelegationV2RepairIntegrity({
        rejectedProgram: rejected,
        repairedProgram: corrected,
        diagnostics: validation.diagnostics,
      }).ok,
    ).toBe(true);

    const replacement = {
      ...program(agentNode("replacement"), [{ from: "replacement", contract: "evidence_collection" }]),
      supersedes: { id: rejected.id, digest: validation.programDigest },
    };
    const integrity = validateDelegationV2RepairIntegrity({
      rejectedProgram: rejected,
      repairedProgram: replacement,
      diagnostics: validation.diagnostics,
    });
    expect(integrity.ok).toBe(false);
    expect(integrity.diagnostics[0].message).toMatch(/removed valid node|undiagnosed fragment/);
  });

  test("accepts exact extra-key, malformed-tag, and hostile-depth repairs", () => {
    const valid = program(agentNode("inspect"), [{ from: "inspect", contract: "evidence_collection" }]);
    const extra = { ...valid, root: { ...valid.root, injectedTool: "shell" } };
    const malformed = { ...valid, root: { ...valid.root, tag: "agnet" } };
    for (const [rejected, repairedRoot] of [
      [extra, valid.root],
      [malformed, valid.root],
    ]) {
      const validation = validateWorkflowProgram(rejected, { rootMaxConcurrency: 2 });
      expect(validation.status).toBe("rejected");
      const repaired = {
        ...valid,
        root: repairedRoot,
        supersedes: { id: valid.id, digest: validation.programDigest },
      };
      expect(
        validateDelegationV2RepairIntegrity({
          rejectedProgram: rejected,
          repairedProgram: repaired,
          diagnostics: validation.diagnostics,
        }).ok,
      ).toBe(true);
    }
    const malformedOutputs = { ...valid, outputs: "not-an-output-list" };
    const outputValidation = validateWorkflowProgram(malformedOutputs, { rootMaxConcurrency: 2 });
    expect(outputValidation.status).toBe("rejected");
    expect(() =>
      validateDelegationV2RepairIntegrity({
        rejectedProgram: malformedOutputs,
        repairedProgram: {
          ...valid,
          supersedes: { id: valid.id, digest: outputValidation.programDigest },
        },
        diagnostics: outputValidation.diagnostics,
      }),
    ).not.toThrow();
    expect(
      validateDelegationV2RepairIntegrity({
        rejectedProgram: malformedOutputs,
        repairedProgram: {
          ...valid,
          supersedes: { id: valid.id, digest: outputValidation.programDigest },
        },
        diagnostics: outputValidation.diagnostics,
      }).ok,
    ).toBe(true);

    const leaf = agentNode("deep-leaf");
    let deepRoot = leaf;
    for (let index = 0; index < 10; index += 1) {
      deepRoot = { tag: "sequence", id: `deep-${index}`, steps: [deepRoot] };
    }
    const deep = program(deepRoot, [{ from: leaf.id, contract: "evidence_collection" }]);
    const depthValidation = validateWorkflowProgram(deep, {
      rootMaxConcurrency: 2,
      limits: { maxDepth: 3 },
    });
    expect(depthValidation.diagnostics.map((diagnostic) => diagnostic.code)).toContain("depth_limit");
    const shallow = {
      ...deep,
      root: { ...deep.root, steps: [leaf] },
      supersedes: { id: deep.id, digest: depthValidation.programDigest },
    };
    expect(validateWorkflowProgram(shallow, { rootMaxConcurrency: 2, limits: { maxDepth: 3 } }).ok).toBe(true);
    expect(
      validateDelegationV2RepairIntegrity({
        rejectedProgram: deep,
        repairedProgram: shallow,
        diagnostics: depthValidation.diagnostics,
      }).ok,
    ).toBe(true);
  });

  test("lets fuel and depth repair prune only the diagnosed excess author topology", () => {
    const excessAuthor = agentNode("excess-author", {
      role: "fable",
      work: "plan",
      outputContract: "plan",
    });
    const retainedTerra = agentNode("retained-terra", {
      role: "terra",
      work: "plan",
      outputContract: "plan",
    });
    const retainedLuna = agentNode("retained-luna");
    const rejected = program(
      {
        tag: "sequence",
        id: "bounded-flow",
        steps: [excessAuthor, retainedTerra, retainedLuna],
      },
      [{ from: "retained-luna", contract: "evidence_collection" }],
    );
    const digest = delegationV2ProgramDigest(rejected);
    const repaired = {
      ...rejected,
      root: { ...rejected.root, steps: [retainedTerra, retainedLuna] },
      supersedes: { id: rejected.id, digest },
    };
    const depthDiagnostics = validateWorkflowProgram(rejected, {
      rootMaxConcurrency: 2,
      allowAuthorChildren: false,
    }).diagnostics;
    expect(depthDiagnostics.map((item) => item.code)).toContain("author_depth_limit");
    expect(
      validateDelegationV2RepairIntegrity({
        rejectedProgram: rejected,
        repairedProgram: repaired,
        diagnostics: depthDiagnostics,
      }).ok,
    ).toBe(true);
    expect(
      validateDelegationV2RepairIntegrity({
        rejectedProgram: rejected,
        repairedProgram: repaired,
        diagnostics: [
          {
            code: "author_fuel_limit",
            path: "root.root",
            message: "The subtree cannot fund this nested author and its parent continuation.",
          },
        ],
      }).ok,
    ).toBe(true);

    const replacement = {
      ...program(agentNode("unrelated"), [{ from: "unrelated", contract: "evidence_collection" }]),
      supersedes: { id: rejected.id, digest },
    };
    expect(
      validateDelegationV2RepairIntegrity({
        rejectedProgram: rejected,
        repairedProgram: replacement,
        diagnostics: [{ code: "author_fuel_limit", path: "root.root", message: "Fuel exhausted." }],
      }).ok,
    ).toBe(false);

    for (const diagnostics of [
      depthDiagnostics,
      [{ code: "author_fuel_limit", path: "root.root", message: "Fuel exhausted." }],
    ]) {
      const droppedSibling = {
        ...rejected,
        root: { ...rejected.root, steps: [retainedLuna] },
        supersedes: { id: rejected.id, digest },
      };
      expect(
        validateDelegationV2RepairIntegrity({
          rejectedProgram: rejected,
          repairedProgram: droppedSibling,
          diagnostics,
        }).ok,
      ).toBe(false);

      const reorderedSiblings = {
        ...rejected,
        root: { ...rejected.root, steps: [retainedLuna, retainedTerra] },
        supersedes: { id: rejected.id, digest },
      };
      expect(
        validateDelegationV2RepairIntegrity({
          rejectedProgram: rejected,
          repairedProgram: reorderedSiblings,
          diagnostics,
        }).ok,
      ).toBe(false);
    }

    const demoted = {
      ...rejected,
      root: {
        ...rejected.root,
        steps: [{ ...excessAuthor, role: "terra" }, retainedTerra, retainedLuna],
      },
      supersedes: { id: rejected.id, digest },
    };
    expect(
      validateDelegationV2RepairIntegrity({
        rejectedProgram: rejected,
        repairedProgram: demoted,
        diagnostics: [{ code: "author_fuel_limit", path: "root.root", message: "Fuel exhausted." }],
      }).ok,
    ).toBe(true);
  });

  test("keeps preserved descendant order while demoting a diagnosed nested author", () => {
    const excessAuthor = agentNode("nested-author", {
      role: "fable",
      work: "plan",
      outputContract: "plan",
    });
    const retainedTerra = agentNode("nested-terra", {
      role: "terra",
      work: "plan",
      outputContract: "plan",
    });
    const retainedLuna = agentNode("nested-luna");
    const workerSequence = {
      tag: "sequence",
      id: "nested-workers",
      steps: [retainedTerra, retainedLuna],
    };
    const rejected = program(
      {
        tag: "sequence",
        id: "nested-bounded-flow",
        steps: [excessAuthor, workerSequence],
      },
      [{ from: retainedLuna.id, contract: retainedLuna.outputContract }],
    );
    const validationOptions = { rootMaxConcurrency: 2, allowAuthorChildren: false };
    const validation = validateWorkflowProgram(rejected, validationOptions);
    expect(validation.diagnostics.map((item) => item.code)).toContain("author_depth_limit");
    const supersedes = { id: rejected.id, digest: validation.programDigest };
    const demotedAuthor = { ...excessAuthor, role: "terra" };
    const repaired = {
      ...rejected,
      root: { ...rejected.root, steps: [demotedAuthor, workerSequence] },
      supersedes,
    };
    expect(validateWorkflowProgram(repaired, validationOptions).ok).toBe(true);
    expect(
      validateDelegationV2RepairIntegrity({
        rejectedProgram: rejected,
        repairedProgram: repaired,
        diagnostics: validation.diagnostics,
      }).ok,
    ).toBe(true);

    const swappedDescendants = {
      ...repaired,
      root: {
        ...repaired.root,
        steps: [demotedAuthor, { ...workerSequence, steps: [retainedLuna, retainedTerra] }],
      },
    };
    expect(validateWorkflowProgram(swappedDescendants, validationOptions).ok).toBe(true);
    const integrity = validateDelegationV2RepairIntegrity({
      rejectedProgram: rejected,
      repairedProgram: swappedDescendants,
      diagnostics: validation.diagnostics,
    });
    expect(integrity.ok).toBe(false);
    expect(integrity.diagnostics[0].message).toMatch(/cannot reorder, re-parent, or remove preserved siblings/);
  });

  test("uses diagnostic paths to repair reachable duplicate-id and author-depth failures", () => {
    const duplicateAuthor = agentNode("shared-id", {
      role: "fable",
      work: "plan",
      outputContract: "plan",
    });
    const duplicateTerra = agentNode("shared-id", {
      role: "terra",
      work: "plan",
      outputContract: "plan",
    });
    const retainedLuna = agentNode("duplicate-tail");
    const rejected = program(
      {
        tag: "sequence",
        id: "duplicate-flow",
        steps: [duplicateAuthor, duplicateTerra, retainedLuna],
      },
      [{ from: retainedLuna.id, contract: retainedLuna.outputContract }],
    );
    const validationOptions = { rootMaxConcurrency: 2, allowAuthorChildren: false };
    const validation = validateWorkflowProgram(rejected, validationOptions);
    expect(validation.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining(["author_depth_limit", "duplicate_id"]),
    );
    const repaired = {
      ...rejected,
      root: {
        ...rejected.root,
        steps: [{ ...duplicateAuthor, role: "terra" }, { ...duplicateTerra, id: "renamed-terra" }, retainedLuna],
      },
      supersedes: { id: rejected.id, digest: validation.programDigest },
    };
    expect(validateWorkflowProgram(repaired, validationOptions).ok).toBe(true);
    expect(
      validateDelegationV2RepairIntegrity({
        rejectedProgram: rejected,
        repairedProgram: repaired,
        diagnostics: validation.diagnostics,
      }),
    ).toEqual({ ok: true, diagnostics: [] });
  });

  test("composes reachable mixed repair scopes without widening author pruning authority", () => {
    const excessAuthor = agentNode("mixed-author", {
      role: "fable",
      work: "plan",
      outputContract: "plan",
    });
    const retainedTerra = agentNode("mixed-terra", {
      role: "terra",
      work: "plan",
      outputContract: "plan",
    });
    const retainedLuna = agentNode("mixed-luna");
    const target = {
      tag: "sequence",
      id: "mixed-target",
      steps: [excessAuthor, retainedTerra, retainedLuna],
    };
    const workers = [1, 2, 3, 4].map((index) => agentNode(`mixed-worker-${index}`));
    const overloaded = {
      tag: "parallel",
      id: "mixed-overloaded",
      branches: workers,
      maxConcurrency: 3,
    };
    const rejected = program(
      {
        tag: "sequence",
        id: "mixed-root",
        steps: [target, overloaded],
      },
      [{ from: retainedLuna.id, contract: retainedLuna.outputContract }],
    );
    const validationOptions = {
      rootMaxConcurrency: 3,
      allowAuthorChildren: false,
      limits: { maxFanout: 3 },
    };
    const validation = validateWorkflowProgram(rejected, validationOptions);
    expect(validation.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining(["author_depth_limit", "fanout_limit"]),
    );
    const digest = delegationV2ProgramDigest(rejected);
    const repairedProgram = (targetSteps) => ({
      ...rejected,
      root: {
        ...rejected.root,
        steps: [
          { ...target, steps: targetSteps },
          { ...overloaded, branches: workers.slice(0, 3) },
        ],
      },
      supersedes: { id: rejected.id, digest },
    });
    const repaired = repairedProgram([retainedTerra, retainedLuna]);

    expect(validateWorkflowProgram(repaired, validationOptions).ok).toBe(true);
    expect(
      validateDelegationV2RepairIntegrity({
        rejectedProgram: rejected,
        repairedProgram: repaired,
        diagnostics: validation.diagnostics,
      }).ok,
    ).toBe(true);
    const widened = validateDelegationV2RepairIntegrity({
      rejectedProgram: rejected,
      repairedProgram: repairedProgram([retainedLuna, retainedTerra]),
      diagnostics: validation.diagnostics,
    });
    expect(widened.ok).toBe(false);
    expect(widened.diagnostics[0].message).toMatch(/cannot reorder, re-parent, or remove preserved siblings/);
  });

  test("keeps structural fanout repair topology-only for every surviving worker", () => {
    const workers = [1, 2, 3, 4].map((index) => agentNode(`fanout-worker-${index}`));
    const rejected = program(
      {
        tag: "parallel",
        id: "overloaded-fanout",
        branches: workers,
        maxConcurrency: 3,
      },
      [{ from: workers[0].id, contract: workers[0].outputContract }],
    );
    const validationOptions = {
      rootMaxConcurrency: 3,
      limits: { maxFanout: 3 },
    };
    const validation = validateWorkflowProgram(rejected, validationOptions);
    expect(validation.diagnostics.map((item) => item.code)).toContain("fanout_limit");
    const repaired = {
      ...rejected,
      root: { ...rejected.root, branches: workers.slice(0, 3) },
      supersedes: { id: rejected.id, digest: validation.programDigest },
    };
    expect(validateWorkflowProgram(repaired, validationOptions).ok).toBe(true);
    expect(
      validateDelegationV2RepairIntegrity({
        rejectedProgram: rejected,
        repairedProgram: repaired,
        diagnostics: validation.diagnostics,
      }).ok,
    ).toBe(true);

    const rewrittenSurvivor = {
      ...repaired,
      root: {
        ...repaired.root,
        branches: [
          {
            ...workers[0],
            prompt: { ...workers[0].prompt, instructions: "Replace the diagnosed task with unrelated work." },
          },
          ...workers.slice(1, 3),
        ],
      },
    };
    expect(validateWorkflowProgram(rewrittenSurvivor, validationOptions).ok).toBe(true);
    const integrity = validateDelegationV2RepairIntegrity({
      rejectedProgram: rejected,
      repairedProgram: rewrittenSurvivor,
      diagnostics: validation.diagnostics,
    });
    expect(integrity.ok).toBe(false);
    expect(integrity.diagnostics[0].message).toMatch(/changed valid node fragment/);
  });

  test("keeps surviving nested topology protected during direct fanout pruning", () => {
    const nestedA = agentNode("nested-fanout-a");
    const nestedB = agentNode("nested-fanout-b");
    const nested = {
      tag: "sequence",
      id: "nested-fanout-sequence",
      steps: [nestedA, nestedB],
    };
    const directWorkers = [1, 2, 3].map((index) => agentNode(`nested-direct-${index}`));
    const rejected = program(
      {
        tag: "parallel",
        id: "nested-overloaded-fanout",
        branches: [nested, ...directWorkers],
        maxConcurrency: 3,
      },
      [{ from: nestedA.id, contract: nestedA.outputContract }],
    );
    const validationOptions = { rootMaxConcurrency: 3, limits: { maxFanout: 3 } };
    const validation = validateWorkflowProgram(rejected, validationOptions);
    expect(validation.diagnostics.map((item) => item.code)).toContain("fanout_limit");
    const supersedes = { id: rejected.id, digest: validation.programDigest };
    const repaired = {
      ...rejected,
      root: { ...rejected.root, branches: [nested, ...directWorkers.slice(0, 2)] },
      supersedes,
    };
    expect(validateWorkflowProgram(repaired, validationOptions).ok).toBe(true);
    expect(
      validateDelegationV2RepairIntegrity({
        rejectedProgram: rejected,
        repairedProgram: repaired,
        diagnostics: validation.diagnostics,
      }).ok,
    ).toBe(true);

    for (const nestedRepair of [
      { ...nested, steps: [nestedB, nestedA] },
      { ...nested, steps: [nestedA] },
    ]) {
      const widened = {
        ...repaired,
        root: { ...repaired.root, branches: [nestedRepair, ...directWorkers.slice(0, 2)] },
      };
      expect(validateWorkflowProgram(widened, validationOptions).ok).toBe(true);
      const integrity = validateDelegationV2RepairIntegrity({
        rejectedProgram: rejected,
        repairedProgram: widened,
        diagnostics: validation.diagnostics,
      });
      expect(integrity.ok).toBe(false);
      expect(integrity.diagnostics[0].message).toMatch(
        /cannot reorder, re-parent, or remove preserved siblings|removed valid node/,
      );
    }
  });

  test("keeps exact duplicate-id repair attached after an earlier fanout branch is pruned", () => {
    const dropped = agentNode("shifted-drop");
    const duplicateA = agentNode("shifted-shared", {
      prompt: { instructions: "Investigate the first duplicate occurrence.", contextRefs: [] },
    });
    const duplicateB = agentNode("shifted-shared", {
      prompt: { instructions: "Investigate the second duplicate occurrence.", contextRefs: [] },
    });
    const tail = agentNode("shifted-tail");
    const rejected = program(
      {
        tag: "parallel",
        id: "shifted-duplicate-fanout",
        branches: [dropped, duplicateA, duplicateB, tail],
        maxConcurrency: 3,
      },
      [{ from: tail.id, contract: tail.outputContract }],
    );
    const validationOptions = { rootMaxConcurrency: 3, limits: { maxFanout: 3 } };
    const validation = validateWorkflowProgram(rejected, validationOptions);
    expect(validation.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining(["duplicate_id", "fanout_limit"]),
    );
    const renamedDuplicate = { ...duplicateB, id: "shifted-shared-repaired" };
    const repaired = {
      ...rejected,
      root: {
        ...rejected.root,
        branches: [duplicateA, renamedDuplicate, tail],
      },
      supersedes: { id: rejected.id, digest: validation.programDigest },
    };
    expect(validateWorkflowProgram(repaired, validationOptions).ok).toBe(true);
    expect(
      validateDelegationV2RepairIntegrity({
        rejectedProgram: rejected,
        repairedProgram: repaired,
        diagnostics: validation.diagnostics,
      }).ok,
    ).toBe(true);

    const reordered = {
      ...repaired,
      root: { ...repaired.root, branches: [renamedDuplicate, duplicateA, tail] },
    };
    expect(validateWorkflowProgram(reordered, validationOptions).ok).toBe(true);
    expect(
      validateDelegationV2RepairIntegrity({
        rejectedProgram: rejected,
        repairedProgram: reordered,
        diagnostics: validation.diagnostics,
      }).ok,
    ).toBe(true);

    const rewrittenDiagnosedOccurrence = {
      ...repaired,
      root: {
        ...repaired.root,
        branches: [
          duplicateA,
          {
            ...renamedDuplicate,
            prompt: { ...renamedDuplicate.prompt, instructions: "Perform unrelated work." },
          },
          tail,
        ],
      },
    };
    expect(validateWorkflowProgram(rewrittenDiagnosedOccurrence, validationOptions).ok).toBe(true);
    expect(
      validateDelegationV2RepairIntegrity({
        rejectedProgram: rejected,
        repairedProgram: rewrittenDiagnosedOccurrence,
        diagnostics: validation.diagnostics,
      }).ok,
    ).toBe(false);

    const renamedWrongOccurrence = {
      ...repaired,
      root: {
        ...repaired.root,
        branches: [{ ...duplicateA, id: "shifted-shared-repaired" }, duplicateB, tail],
      },
    };
    expect(validateWorkflowProgram(renamedWrongOccurrence, validationOptions).ok).toBe(true);
    expect(
      validateDelegationV2RepairIntegrity({
        rejectedProgram: rejected,
        repairedProgram: renamedWrongOccurrence,
        diagnostics: validation.diagnostics,
      }).ok,
    ).toBe(false);
  });

  test("matches diagnosed ids before checking exact mechanical reference rewrites", () => {
    const source = agentNode("system");
    const duplicateA = agentNode("mechanical-shared");
    const duplicateB = agentNode("mechanical-shared", {
      inputs: [{ from: source.id, contract: source.outputContract, purpose: "Use the source evidence." }],
      prompt: { instructions: "Use the source evidence.", contextRefs: [source.id] },
    });
    const tail = agentNode("mechanical-tail", {
      inputs: [{ from: duplicateA.id, contract: duplicateA.outputContract, purpose: "Use the shared evidence." }],
      prompt: { instructions: "Use the shared evidence.", contextRefs: [duplicateA.id] },
    });
    const rejected = program(
      {
        tag: "sequence",
        id: "mechanical-reference-flow",
        steps: [source, duplicateA, duplicateB, tail],
      },
      [{ from: tail.id, contract: tail.outputContract }],
    );
    const validationOptions = { rootMaxConcurrency: 2 };
    const validation = validateWorkflowProgram(rejected, validationOptions);
    expect(validation.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining(["duplicate_id", "reserved_id"]),
    );
    const repairedSource = { ...source, id: "mechanical-source" };
    const repairedDuplicate = {
      ...duplicateB,
      id: "mechanical-shared-repaired",
      inputs: [{ ...duplicateB.inputs[0], from: repairedSource.id }],
      prompt: { ...duplicateB.prompt, contextRefs: [repairedSource.id] },
    };
    const repaired = {
      ...rejected,
      root: {
        ...rejected.root,
        steps: [repairedSource, duplicateA, repairedDuplicate, tail],
      },
      supersedes: { id: rejected.id, digest: validation.programDigest },
    };
    expect(validateWorkflowProgram(repaired, validationOptions).ok).toBe(true);
    expect(
      validateDelegationV2RepairIntegrity({
        rejectedProgram: rejected,
        repairedProgram: repaired,
        diagnostics: validation.diagnostics,
      }).ok,
    ).toBe(true);

    const ambiguousDuplicateRef = {
      ...repaired,
      root: {
        ...repaired.root,
        steps: [
          repairedSource,
          duplicateA,
          repairedDuplicate,
          {
            ...tail,
            inputs: [{ ...tail.inputs[0], from: repairedDuplicate.id }],
            prompt: { ...tail.prompt, contextRefs: [repairedDuplicate.id] },
          },
        ],
      },
    };
    expect(validateWorkflowProgram(ambiguousDuplicateRef, validationOptions).ok).toBe(true);
    expect(
      validateDelegationV2RepairIntegrity({
        rejectedProgram: rejected,
        repairedProgram: ambiguousDuplicateRef,
        diagnostics: validation.diagnostics,
      }).ok,
    ).toBe(false);
  });

  test("uses transformed references before topology position to pair multiple duplicate-id repairs", () => {
    const sourceOne = agentNode("multi-source-one");
    const sourceTwo = agentNode("multi-source-two");
    const dropped = agentNode("multi-drop");
    const canonical = agentNode("multi-shared");
    const duplicateFor = (source) =>
      agentNode("multi-shared", {
        inputs: [{ from: source.id, contract: source.outputContract, purpose: "Use the selected source." }],
        prompt: { instructions: "Use the selected source.", contextRefs: [source.id] },
      });
    const duplicateOne = duplicateFor(sourceOne);
    const duplicateTwo = duplicateFor(sourceTwo);
    const tail = agentNode("multi-tail");
    const fanout = {
      tag: "parallel",
      id: "multi-duplicate-fanout",
      branches: [dropped, canonical, duplicateOne, duplicateTwo, tail],
      maxConcurrency: 4,
    };
    const rejected = program(
      {
        tag: "sequence",
        id: "multi-duplicate-flow",
        steps: [sourceOne, sourceTwo, fanout],
      },
      [{ from: tail.id, contract: tail.outputContract }],
    );
    const validationOptions = { rootMaxConcurrency: 4, limits: { maxFanout: 4 } };
    const validation = validateWorkflowProgram(rejected, validationOptions);
    expect(validation.diagnostics.filter((item) => item.code === "duplicate_id")).toHaveLength(2);
    expect(validation.diagnostics.map((item) => item.code)).toContain("fanout_limit");
    const renamedOne = { ...duplicateOne, id: "multi-shared-one" };
    const renamedTwo = { ...duplicateTwo, id: "multi-shared-two" };
    const repaired = {
      ...rejected,
      root: {
        ...rejected.root,
        steps: [
          sourceOne,
          sourceTwo,
          {
            ...fanout,
            branches: [renamedOne, renamedTwo, canonical, tail],
          },
        ],
      },
      supersedes: { id: rejected.id, digest: validation.programDigest },
    };
    expect(validateWorkflowProgram(repaired, validationOptions).ok).toBe(true);
    expect(
      validateDelegationV2RepairIntegrity({
        rejectedProgram: rejected,
        repairedProgram: repaired,
        diagnostics: validation.diagnostics,
      }),
    ).toEqual({ ok: true, diagnostics: [] });
  });

  test("scopes aggregate prompt repair to existing instruction fields", () => {
    const first = agentNode("prompt-budget-first", {
      prompt: { instructions: "123456789", contextRefs: [] },
    });
    const second = agentNode("prompt-budget-second", {
      prompt: { instructions: "abcdefghi", contextRefs: [] },
    });
    const rejected = program(
      {
        tag: "sequence",
        id: "prompt-budget-flow",
        steps: [first, second],
      },
      [{ from: second.id, contract: second.outputContract }],
    );
    const validationOptions = {
      rootMaxConcurrency: 2,
      limits: { maxPromptBytes: 20, maxTotalPromptBytes: 12 },
    };
    const validation = validateWorkflowProgram(rejected, validationOptions);
    expect(validation.diagnostics.map((item) => item.code)).toEqual(["total_prompt_limit"]);
    const shortenedFirst = {
      ...first,
      prompt: { ...first.prompt, instructions: "one" },
    };
    const shortenedSecond = {
      ...second,
      prompt: { ...second.prompt, instructions: "two" },
    };
    const repaired = {
      ...rejected,
      root: { ...rejected.root, steps: [shortenedFirst, shortenedSecond] },
      supersedes: { id: rejected.id, digest: validation.programDigest },
    };
    expect(validateWorkflowProgram(repaired, validationOptions).ok).toBe(true);
    expect(
      validateDelegationV2RepairIntegrity({
        rejectedProgram: rejected,
        repairedProgram: repaired,
        diagnostics: validation.diagnostics,
      }).ok,
    ).toBe(true);

    const widenedPrograms = [
      {
        ...repaired,
        root: { ...repaired.root, steps: [{ ...shortenedFirst, role: "terra" }, shortenedSecond] },
      },
      {
        ...repaired,
        root: {
          ...repaired.root,
          steps: [
            { ...shortenedFirst, goal: { ...shortenedFirst.goal, objective: "Unrelated objective." } },
            shortenedSecond,
          ],
        },
      },
      {
        ...repaired,
        root: { ...repaired.root, steps: [{ ...shortenedFirst, id: "prompt-budget-renamed" }, shortenedSecond] },
      },
      {
        ...repaired,
        outputs: [{ from: first.id, contract: first.outputContract }],
      },
    ];
    for (const widened of widenedPrograms) {
      expect(validateWorkflowProgram(widened, validationOptions).ok).toBe(true);
      expect(
        validateDelegationV2RepairIntegrity({
          rejectedProgram: rejected,
          repairedProgram: widened,
          diagnostics: validation.diagnostics,
        }).ok,
      ).toBe(false);
    }
  });

  test("allows only the bounded policy/review edits needed to repair critical execution", () => {
    const criticality = {
      category: "protocol_core",
      invariant: "Protocol frames replay identically.",
      whyHighTierIsRequired: "Every changed branch affects durable identity.",
      whyTheCoreCannotBeDelegated: "Splitting the proof loses frame-level context.",
      allowedPaths: ["packages/engine/src/protocol.js"],
      expectedChangedLines: 18,
      lineSensitivity: "Each line participates in canonical encoding.",
      surroundingWorkDelegatedTo: ["critical-review"],
      reviewNodeId: "critical-review",
    };
    const execute = agentNode("critical-core", {
      role: "sol",
      work: "execute",
      outputContract: "work_product",
      criticality,
    });
    const review = agentNode("critical-review", {
      work: "review",
      outputContract: "evaluation",
      inputs: [{ from: "critical-core", contract: "work_product", purpose: "Review the bounded critical core." }],
      prompt: { instructions: "Independently review the protocol invariant.", contextRefs: ["critical-core"] },
    });
    const spectator = agentNode("critical-spectator");
    const root = { tag: "sequence", id: "critical-flow", steps: [execute, review, spectator] };
    const delegated = program(root, [{ from: "critical-review", contract: "evaluation" }]);
    const ungranted = validateWorkflowProgram(delegated, { rootMaxConcurrency: 2 });
    const demoted = {
      ...delegated,
      root: { ...root, steps: [{ ...execute, role: "luna", criticality: undefined }, review, spectator] },
      supersedes: { id: delegated.id, digest: ungranted.programDigest },
    };
    delete demoted.root.steps[0].criticality;
    expect(validateWorkflowProgram(demoted, { rootMaxConcurrency: 2 }).ok).toBe(true);
    expect(
      validateDelegationV2RepairIntegrity({
        rejectedProgram: delegated,
        repairedProgram: demoted,
        diagnostics: ungranted.diagnostics,
      }).ok,
    ).toBe(true);

    const policy = {
      allowedCategories: ["protocol_core"],
      allowedPathPrefixes: ["packages/engine/src"],
      maxChangedLines: 30,
    };
    const racing = program(root, [{ from: "critical-core", contract: "work_product" }]);
    const racingValidation = validateWorkflowProgram(racing, {
      rootMaxConcurrency: 2,
      criticalExecutionPolicy: policy,
    });
    expect(racingValidation.diagnostics.map((item) => item.code)).toContain("critical_review_not_joined");
    const joined = {
      ...racing,
      outputs: [...racing.outputs, { from: "critical-review", contract: "evaluation" }],
      supersedes: { id: racing.id, digest: racingValidation.programDigest },
    };
    expect(validateWorkflowProgram(joined, { rootMaxConcurrency: 2, criticalExecutionPolicy: policy }).ok).toBe(true);
    expect(
      validateDelegationV2RepairIntegrity({
        rejectedProgram: racing,
        repairedProgram: joined,
        diagnostics: racingValidation.diagnostics,
      }).ok,
    ).toBe(true);

    const joinedWithUnrelatedOutput = {
      ...joined,
      outputs: [...joined.outputs, { from: spectator.id, contract: spectator.outputContract }],
    };
    expect(
      validateWorkflowProgram(joinedWithUnrelatedOutput, {
        rootMaxConcurrency: 2,
        criticalExecutionPolicy: policy,
      }).ok,
    ).toBe(true);
    expect(
      validateDelegationV2RepairIntegrity({
        rejectedProgram: racing,
        repairedProgram: joinedWithUnrelatedOutput,
        diagnostics: racingValidation.diagnostics,
      }).ok,
    ).toBe(false);
  });

  test("mechanically updates every critical reference after a unique reviewer id repair", () => {
    const policy = {
      allowedCategories: ["protocol_core"],
      allowedPathPrefixes: ["packages/engine/src"],
      maxChangedLines: 30,
    };
    const execute = agentNode("reserved-review-execute", {
      role: "sol",
      work: "execute",
      outputContract: "work_product",
      criticality: {
        category: "protocol_core",
        invariant: "The durable protocol remains canonical.",
        whyHighTierIsRequired: "Every byte affects replay identity.",
        whyTheCoreCannotBeDelegated: "Splitting the proof loses protocol context.",
        allowedPaths: ["packages/engine/src/protocol.js"],
        expectedChangedLines: 12,
        lineSensitivity: "Each line participates in canonical encoding.",
        surroundingWorkDelegatedTo: ["system"],
        reviewNodeId: "system",
      },
    });
    const reviewer = agentNode("system", {
      work: "review",
      outputContract: "evaluation",
      inputs: [{ from: execute.id, contract: execute.outputContract, purpose: "Review the critical execution." }],
      prompt: { instructions: "Independently review the protocol.", contextRefs: [execute.id] },
    });
    const rejected = program(
      {
        tag: "sequence",
        id: "reserved-review-flow",
        steps: [execute, reviewer],
      },
      [{ from: reviewer.id, contract: reviewer.outputContract }],
    );
    const validationOptions = { rootMaxConcurrency: 2, criticalExecutionPolicy: policy };
    const validation = validateWorkflowProgram(rejected, validationOptions);
    expect(validation.diagnostics.map((item) => item.code)).toEqual(["reserved_id"]);
    const repairedReviewer = { ...reviewer, id: "reserved-review-repaired" };
    const repairedExecute = {
      ...execute,
      criticality: {
        ...execute.criticality,
        reviewNodeId: repairedReviewer.id,
        surroundingWorkDelegatedTo: [repairedReviewer.id],
      },
    };
    const repaired = {
      ...rejected,
      root: { ...rejected.root, steps: [repairedExecute, repairedReviewer] },
      outputs: [{ from: repairedReviewer.id, contract: repairedReviewer.outputContract }],
      supersedes: { id: rejected.id, digest: validation.programDigest },
    };
    expect(validateWorkflowProgram(repaired, validationOptions).ok).toBe(true);
    expect(
      validateDelegationV2RepairIntegrity({
        rejectedProgram: rejected,
        repairedProgram: repaired,
        diagnostics: validation.diagnostics,
      }).ok,
    ).toBe(true);
  });

  test("requires the exact deduplicated review joins for multiple critical executions", () => {
    const policy = {
      allowedCategories: ["protocol_core"],
      allowedPathPrefixes: ["packages/engine/src"],
      maxChangedLines: 30,
    };
    const criticalityFor = (reviewNodeId, path) => ({
      category: "protocol_core",
      invariant: `Protocol invariant for ${path}.`,
      whyHighTierIsRequired: "Every changed branch affects durable identity.",
      whyTheCoreCannotBeDelegated: "Splitting the proof loses frame-level context.",
      allowedPaths: [path],
      expectedChangedLines: 12,
      lineSensitivity: "Each line participates in canonical encoding.",
      surroundingWorkDelegatedTo: [reviewNodeId],
      reviewNodeId,
    });
    const executeA = agentNode("critical-a", {
      role: "sol",
      work: "execute",
      outputContract: "work_product",
      criticality: criticalityFor("review-a", "packages/engine/src/a.js"),
    });
    const reviewA = agentNode("review-a", {
      work: "review",
      outputContract: "evaluation",
      inputs: [{ from: executeA.id, contract: executeA.outputContract, purpose: "Review critical A." }],
      prompt: { instructions: "Independently review critical A.", contextRefs: [executeA.id] },
    });
    const executeB = agentNode("critical-b", {
      role: "sol",
      work: "execute",
      outputContract: "work_product",
      criticality: criticalityFor("review-b", "packages/engine/src/b.js"),
    });
    const reviewB = agentNode("review-b", {
      work: "review",
      outputContract: "evaluation",
      inputs: [{ from: executeB.id, contract: executeB.outputContract, purpose: "Review critical B." }],
      prompt: { instructions: "Independently review critical B.", contextRefs: [executeB.id] },
    });
    const rejected = program(
      {
        tag: "sequence",
        id: "two-critical-flows",
        steps: [executeA, reviewA, executeB, reviewB],
      },
      [
        { from: executeA.id, contract: executeA.outputContract },
        { from: executeB.id, contract: executeB.outputContract },
      ],
    );
    const validationOptions = { rootMaxConcurrency: 2, criticalExecutionPolicy: policy };
    const validation = validateWorkflowProgram(rejected, validationOptions);
    expect(validation.diagnostics.filter((item) => item.code === "critical_review_not_joined")).toHaveLength(2);
    const repaired = {
      ...rejected,
      outputs: [
        ...rejected.outputs,
        { from: reviewA.id, contract: reviewA.outputContract },
        { from: reviewB.id, contract: reviewB.outputContract },
      ],
      supersedes: { id: rejected.id, digest: validation.programDigest },
    };
    expect(validateWorkflowProgram(repaired, validationOptions).ok).toBe(true);
    expect(
      validateDelegationV2RepairIntegrity({
        rejectedProgram: rejected,
        repairedProgram: repaired,
        diagnostics: validation.diagnostics,
      }).ok,
    ).toBe(true);

    const incomplete = { ...repaired, outputs: repaired.outputs.slice(0, -1) };
    expect(
      validateDelegationV2RepairIntegrity({
        rejectedProgram: rejected,
        repairedProgram: incomplete,
        diagnostics: validation.diagnostics,
      }).ok,
    ).toBe(false);
  });

  test("joins the validator-selected reviewer when a later duplicate id is repaired", () => {
    const policy = {
      allowedCategories: ["protocol_core"],
      allowedPathPrefixes: ["packages/engine/src"],
      maxChangedLines: 30,
    };
    const execute = agentNode("duplicate-review-execute", {
      role: "sol",
      work: "execute",
      outputContract: "work_product",
      criticality: {
        category: "protocol_core",
        invariant: "The durable frame remains canonical.",
        whyHighTierIsRequired: "Every byte affects replay identity.",
        whyTheCoreCannotBeDelegated: "Splitting the proof loses frame-level context.",
        allowedPaths: ["packages/engine/src/frame.js"],
        expectedChangedLines: 12,
        lineSensitivity: "Each line participates in canonical encoding.",
        surroundingWorkDelegatedTo: ["duplicate-review"],
        reviewNodeId: "duplicate-review",
      },
    });
    const reviewer = agentNode("duplicate-review", {
      work: "review",
      outputContract: "evaluation",
      inputs: [{ from: execute.id, contract: execute.outputContract, purpose: "Review the critical execution." }],
      prompt: { instructions: "Independently review the canonical frame.", contextRefs: [execute.id] },
    });
    const duplicate = agentNode("duplicate-review");
    const rejected = program(
      {
        tag: "sequence",
        id: "duplicate-review-flow",
        steps: [execute, reviewer, duplicate],
      },
      [{ from: execute.id, contract: execute.outputContract }],
    );
    const validationOptions = { rootMaxConcurrency: 2, criticalExecutionPolicy: policy };
    const validation = validateWorkflowProgram(rejected, validationOptions);
    expect(validation.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining(["critical_review_not_joined", "duplicate_id"]),
    );
    const renamedDuplicate = { ...duplicate, id: "duplicate-review-repaired" };
    const repaired = {
      ...rejected,
      root: { ...rejected.root, steps: [execute, reviewer, renamedDuplicate] },
      outputs: [...rejected.outputs, { from: reviewer.id, contract: reviewer.outputContract }],
      supersedes: { id: rejected.id, digest: validation.programDigest },
    };
    expect(validateWorkflowProgram(repaired, validationOptions).ok).toBe(true);
    expect(
      validateDelegationV2RepairIntegrity({
        rejectedProgram: rejected,
        repairedProgram: repaired,
        diagnostics: validation.diagnostics,
      }).ok,
    ).toBe(true);

    const surplus = {
      ...repaired,
      outputs: [...repaired.outputs, { from: renamedDuplicate.id, contract: renamedDuplicate.outputContract }],
    };
    expect(validateWorkflowProgram(surplus, validationOptions).ok).toBe(true);
    expect(
      validateDelegationV2RepairIntegrity({
        rejectedProgram: rejected,
        repairedProgram: surplus,
        diagnostics: validation.diagnostics,
      }).ok,
    ).toBe(false);
  });

  test("allows an exact downstream consumer output to join a critical review", () => {
    const policy = {
      allowedCategories: ["protocol_core"],
      allowedPathPrefixes: ["packages/engine/src"],
      maxChangedLines: 30,
    };
    const execute = agentNode("downstream-review-execute", {
      role: "sol",
      work: "execute",
      outputContract: "work_product",
      criticality: {
        category: "protocol_core",
        invariant: "The durable event encoding remains canonical.",
        whyHighTierIsRequired: "Every byte affects replay identity.",
        whyTheCoreCannotBeDelegated: "Splitting the proof loses encoding context.",
        allowedPaths: ["packages/engine/src/event.js"],
        expectedChangedLines: 12,
        lineSensitivity: "Each line participates in canonical encoding.",
        surroundingWorkDelegatedTo: ["downstream-review"],
        reviewNodeId: "downstream-review",
      },
    });
    const reviewer = agentNode("downstream-review", {
      work: "review",
      outputContract: "evaluation",
      inputs: [{ from: execute.id, contract: execute.outputContract, purpose: "Review the critical execution." }],
      prompt: { instructions: "Independently review the event encoding.", contextRefs: [execute.id] },
    });
    const consumer = agentNode("downstream-review-consumer", {
      role: "terra",
      work: "synthesize",
      outputContract: "work_product",
      inputs: [{ from: reviewer.id, contract: reviewer.outputContract, purpose: "Synthesize the independent review." }],
      prompt: { instructions: "Synthesize the review into the final result.", contextRefs: [reviewer.id] },
    });
    const rejected = program(
      {
        tag: "sequence",
        id: "downstream-review-flow",
        steps: [execute, reviewer, consumer],
      },
      [{ from: execute.id, contract: execute.outputContract }],
    );
    const validationOptions = { rootMaxConcurrency: 2, criticalExecutionPolicy: policy };
    const validation = validateWorkflowProgram(rejected, validationOptions);
    expect(validation.diagnostics.filter((item) => item.code === "critical_review_not_joined")).toHaveLength(1);
    const repaired = {
      ...rejected,
      outputs: [...rejected.outputs, { from: consumer.id, contract: consumer.outputContract }],
      supersedes: { id: rejected.id, digest: validation.programDigest },
    };
    expect(validateWorkflowProgram(repaired, validationOptions).ok).toBe(true);
    expect(
      validateDelegationV2RepairIntegrity({
        rejectedProgram: rejected,
        repairedProgram: repaired,
        diagnostics: validation.diagnostics,
      }).ok,
    ).toBe(true);

    const redundantJoin = {
      ...repaired,
      outputs: [...repaired.outputs, { from: reviewer.id, contract: reviewer.outputContract }],
    };
    expect(validateWorkflowProgram(redundantJoin, validationOptions).ok).toBe(true);
    expect(
      validateDelegationV2RepairIntegrity({
        rejectedProgram: rejected,
        repairedProgram: redundantJoin,
        diagnostics: validation.diagnostics,
      }).ok,
    ).toBe(false);
  });
});

describe("Trellis graph rendering", () => {
  test("persists pinned run limits and root-local author fuel in trusted metadata", async () => {
    const initial = await render(
      {},
      {
        limits: {
          maxTotalAuthorTurns: 11,
          maxAuthorGenerations: 3,
          maxAuthorDepth: 2,
        },
      },
    );
    const rootAuthor = initial.tasks.find((task) => task.meta?.trellis?.phase === "initial");
    expect(rootAuthor.meta.trellis).toMatchObject({
      logicalId: "root",
      rootMaxConcurrency: 2,
      rootAuthorTurnsTotal: 11,
      rootMaxAuthorGenerations: 3,
      rootMaxAuthorDepth: 2,
      invocationAuthorTurnsAllocated: 11,
      invocationAuthorTurnsRemaining: 10,
    });
  });

  test("mounts immutable author, validation, and compiled worker phases as rows arrive", async () => {
    const authored = program(agentNode("inspect"), [{ from: "inspect", contract: "evidence_collection" }]);

    const initial = await render();
    const authorTask = initial.tasks.find((task) => task.meta?.trellis?.phase === "initial");
    const invocationKey = authorTask.meta.trellis.invocationKey;
    const authorId = turnNodeId({ invocationKey, generation: 0, phase: "author" });
    const validationId = turnNodeId({ invocationKey, generation: 0, phase: "validate" });
    expect(initial.tasks.map((task) => task.nodeId)).toEqual([authorId]);

    const afterAuthor = await render({
      dv2Author: [{ nodeId: authorId, iteration: 0, ...subworkflowEnvelope(authored) }],
    });
    expect(afterAuthor.tasks.map((task) => task.nodeId)).toEqual([authorId, validationId]);

    const digest = delegationV2ProgramDigest(authored);
    const plan = compileDelegationV2Program({
      program: authored,
      invocationKey,
      authorNodeId: authorId,
      generation: 0,
      programDigest: digest,
      rootMaxConcurrency: 2,
      entryDependsOn: [validationId],
    });
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
      stats: {
        nodes: 1,
        agents: 1,
        authors: 0,
        maxDepth: 1,
        maxFanout: 0,
        totalPromptBytes: authored.root.prompt.instructions.length,
      },
    };
    const afterValidation = await render({
      dv2Author: [{ nodeId: authorId, iteration: 0, ...subworkflowEnvelope(authored) }],
      dv2Validation: [accepted],
    });
    expect(afterValidation.tasks.map((task) => task.nodeId)).toEqual([authorId, validationId, plan.root.rawNodeId]);

    const afterWorker = await render({
      dv2Author: [{ nodeId: authorId, iteration: 0, ...subworkflowEnvelope(authored) }],
      dv2Validation: [accepted],
      dv2Worker: [{ nodeId: plan.root.rawNodeId, iteration: 0, ...workerEnvelope("research") }],
    });
    expect(afterWorker.tasks.map((task) => task.nodeId)).toEqual([
      authorId,
      validationId,
      plan.root.rawNodeId,
      plan.root.outcomeNodeId,
    ]);
  });

  test("puts an actor-bound critical execution grant in the exact nested author authority", async () => {
    const criticalAgents = {
      sol: { id: "critical-sol", tools: {}, generate: inertAgent.generate },
      fable: inertAgent,
      terra: inertAgent,
      luna: { id: "independent-luna-reviewer", tools: {}, generate: inertAgent.generate },
    };
    const criticalReviewIndependentRoles = deriveCriticalReviewIndependentRoles(criticalAgents);
    const criticalExecutionPolicy = {
      allowedCategories: ["protocol_core"],
      allowedPathPrefixes: ["packages/engine/src"],
      maxChangedLines: 30,
    };
    const execute = agentNode("critical-core", {
      role: "sol",
      work: "execute",
      outputContract: "work_product",
      criticality: {
        category: "protocol_core",
        invariant: "Protocol frames replay identically.",
        whyHighTierIsRequired: "Every changed branch affects durable identity.",
        whyTheCoreCannotBeDelegated: "Splitting the proof loses frame-level context.",
        allowedPaths: ["packages/engine/src/protocol.js"],
        expectedChangedLines: 18,
        lineSensitivity: "Each line participates in canonical encoding.",
        surroundingWorkDelegatedTo: ["critical-review"],
        reviewNodeId: "critical-review",
      },
    });
    const review = agentNode("critical-review", {
      work: "review",
      outputContract: "evaluation",
      inputs: [{ from: "critical-core", contract: "work_product", purpose: "Review the bounded critical core." }],
      prompt: { instructions: "Independently review the protocol invariant.", contextRefs: ["critical-core"] },
    });
    const authored = program({ tag: "sequence", id: "critical-flow", steps: [execute, review] }, [
      { from: "critical-review", contract: "evaluation" },
    ]);
    const initialWithoutPolicy = await render({}, { agents: criticalAgents });
    const initial = await render({}, { agents: criticalAgents, criticalExecutionPolicy });
    const rootAuthor = initial.tasks.find((task) => task.meta?.trellis?.phase === "initial");
    expect(rootAuthor.nodeId).not.toBe(initialWithoutPolicy.tasks[0].nodeId);
    const invocationKey = rootAuthor.meta.trellis.invocationKey;
    const authorId = turnNodeId({ invocationKey, generation: 0, phase: "author" });
    const validationId = turnNodeId({ invocationKey, generation: 0, phase: "validate" });
    const validation = validateWorkflowProgram(authored, {
      rootMaxConcurrency: 2,
      criticalExecutionPolicy,
      criticalReviewIndependentRoles,
    });
    expect(validation.ok).toBe(true);
    const plan = compileDelegationV2Program({
      program: validation.normalizedProgram,
      invocationKey,
      authorNodeId: authorId,
      generation: 0,
      programDigest: validation.programDigest,
      rootMaxConcurrency: 2,
      criticalExecutionPolicy,
      criticalReviewIndependentRoles,
      entryDependsOn: [validationId],
    });
    const accepted = {
      nodeId: validationId,
      iteration: 0,
      invocationKey,
      generation: 0,
      authorNodeId: authorId,
      status: "accepted",
      programDigest: validation.programDigest,
      registryVersion: DELEGATION_V2_REGISTRY_VERSION,
      compilerVersion: DELEGATION_V2_COMPILER_VERSION,
      criticalExecutionPolicyHash: plan.criticalExecutionPolicyHash,
      normalizedProgram: validation.normalizedProgram,
      diagnostics: [],
      stats: validation.stats,
    };
    const rendered = await render(
      {
        dv2Author: [{ nodeId: authorId, iteration: 0, ...subworkflowEnvelope(authored) }],
        dv2Validation: [accepted],
      },
      { agents: criticalAgents, criticalExecutionPolicy },
    );
    const nested = rendered.tasks.find(
      (task) => task.meta?.trellis?.logicalId === "critical-core" && task.meta?.trellis?.phase === "initial",
    );
    const grant = plan.root.steps[0].criticalExecutionGrant;
    expect(nested.meta.trellis.criticalExecutionGrantHash).toBe(grant.grantHash);
    expect(nested.meta.trellis.criticalExecutionPolicyHash).toBe(grant.policyHash);
    expect(JSON.stringify(nested)).toContain(grant.grantHash);
  });

  test("keeps a capped Parallel ancestor authoritative across recursive author renders", async () => {
    const architect = agentNode("architect", {
      role: "fable",
      work: "plan",
      outputContract: "plan",
    });
    const scout = agentNode("scout");
    const rootFragment = program(
      {
        tag: "parallel",
        id: "bounded-wave",
        maxConcurrency: 2,
        branches: [architect, scout],
      },
      [
        { from: "architect", contract: "plan" },
        { from: "scout", contract: "evidence_collection" },
      ],
    );
    const nestedParallel = program(
      {
        tag: "parallel",
        id: "escaping-wave",
        maxConcurrency: 2,
        branches: [agentNode("nested-one"), agentNode("nested-two")],
      },
      [
        { from: "nested-one", contract: "evidence_collection" },
        { from: "nested-two", contract: "evidence_collection" },
      ],
    );

    const initial = await render();
    const invocationKey = initial.tasks[0].meta.trellis.invocationKey;
    const authorId = turnNodeId({ invocationKey, generation: 0, phase: "author" });
    const validationId = turnNodeId({ invocationKey, generation: 0, phase: "validate" });
    const validation = validateWorkflowProgram(rootFragment, { rootMaxConcurrency: 2 });
    expect(validation.ok).toBe(true);
    const plan = compileDelegationV2Program({
      program: validation.normalizedProgram,
      invocationKey,
      authorNodeId: authorId,
      generation: 0,
      programDigest: validation.programDigest,
      rootMaxConcurrency: 2,
      entryDependsOn: [validationId],
    });
    const accepted = {
      nodeId: validationId,
      iteration: 0,
      invocationKey,
      generation: 0,
      authorNodeId: authorId,
      status: "accepted",
      programDigest: validation.programDigest,
      registryVersion: DELEGATION_V2_REGISTRY_VERSION,
      compilerVersion: DELEGATION_V2_COMPILER_VERSION,
      normalizedProgram: validation.normalizedProgram,
      diagnostics: [],
      stats: validation.stats,
    };
    const nestedInvocationKey = plan.root.branches[0].nestedInvocationKey;
    const nestedAuthorId = turnNodeId({ invocationKey: nestedInvocationKey, generation: 0, phase: "author" });
    const nestedValidationId = turnNodeId({ invocationKey: nestedInvocationKey, generation: 0, phase: "validate" });
    const rows = {
      dv2Author: [
        { nodeId: authorId, iteration: 0, ...subworkflowEnvelope(rootFragment) },
        { nodeId: nestedAuthorId, iteration: 0, ...subworkflowEnvelope(nestedParallel) },
      ],
      dv2Validation: [accepted],
    };
    const frame = await render(rows);
    const nestedAuthor = frame.tasks.find((task) => task.nodeId === nestedAuthorId);
    expect(nestedAuthor.prompt).toContain('"hasCappedParallelAncestor": true');
    const nestedValidation = frame.tasks.find((task) => task.nodeId === nestedValidationId);
    expect(nestedValidation.staticPayload.diagnostics.map((item) => item.code)).toContain(
      "unsupported_nested_concurrency",
    );
  });

  test("does not mount a speculative outcome while semantic repair is pending", async () => {
    const rejected = program(agentNode("inspect", { work: "plan" }), [
      { from: "inspect", contract: "evidence_collection" },
    ]);
    const initial = await render();
    const invocationKey = initial.tasks[0].meta.trellis.invocationKey;
    const authorId = turnNodeId({ invocationKey, generation: 0, phase: "author" });
    const validationId = turnNodeId({ invocationKey, generation: 0, phase: "validate" });
    const repairId = turnNodeId({ invocationKey, generation: 0, phase: "repair" });
    const frame = await render({
      dv2Author: [{ nodeId: authorId, iteration: 0, ...subworkflowEnvelope(rejected) }],
      dv2Validation: [
        {
          nodeId: validationId,
          iteration: 0,
          invocationKey,
          generation: 0,
          authorNodeId: authorId,
          status: "rejected",
          programDigest: delegationV2ProgramDigest(rejected),
          registryVersion: DELEGATION_V2_REGISTRY_VERSION,
          compilerVersion: DELEGATION_V2_COMPILER_VERSION,
          diagnostics: [
            {
              code: "role_work_forbidden",
              path: "root.root.work",
              message: "Luna cannot plan.",
              nodeId: "inspect",
            },
          ],
          stats: { nodes: 1, agents: 1, authors: 0, maxDepth: 1, maxFanout: 0, totalPromptBytes: 20 },
        },
      ],
    });
    expect(frame.tasks.map((task) => task.nodeId)).toEqual([authorId, validationId, repairId]);
    expect(frame.tasks.some((task) => task.meta?.trellis?.phase === "outcome")).toBe(false);
  });

  test("routes schema-invalid authored IR through validation and one-shot repair", async () => {
    const valid = program(agentNode("inspect"), [{ from: "inspect", contract: "evidence_collection" }]);
    let deepRoot = valid.root;
    for (let index = 0; index < 10; index += 1)
      deepRoot = { tag: "sequence", id: `too-deep-${index}`, steps: [deepRoot] };
    const cases = [
      { ...valid, root: { ...valid.root, injectedTool: "shell" } },
      { ...valid, root: { ...valid.root, tag: "agnet" } },
      { ...valid, root: deepRoot },
    ];
    for (const rejected of cases) {
      const initial = await render();
      const invocationKey = initial.tasks[0].meta.trellis.invocationKey;
      const authorId = turnNodeId({ invocationKey, generation: 0, phase: "author" });
      const validationId = turnNodeId({ invocationKey, generation: 0, phase: "validate" });
      const repairId = turnNodeId({ invocationKey, generation: 0, phase: "repair" });
      const validation = validateWorkflowProgram(rejected, {
        rootMaxConcurrency: 2,
        expectedRegistryVersion: DELEGATION_V2_REGISTRY_VERSION,
      });
      expect(validation.status).toBe("rejected");
      const afterAuthor = await render({
        dv2Author: [{ nodeId: authorId, iteration: 0, ...subworkflowEnvelope(rejected) }],
      });
      expect(afterAuthor.tasks.map((task) => task.nodeId)).toEqual([authorId, validationId]);
      const afterValidation = await render({
        dv2Author: [{ nodeId: authorId, iteration: 0, ...subworkflowEnvelope(rejected) }],
        dv2Validation: [
          {
            nodeId: validationId,
            iteration: 0,
            invocationKey,
            generation: 0,
            authorNodeId: authorId,
            status: "rejected",
            programDigest: validation.programDigest,
            registryVersion: DELEGATION_V2_REGISTRY_VERSION,
            compilerVersion: DELEGATION_V2_COMPILER_VERSION,
            diagnostics: validation.diagnostics,
            stats: validation.stats,
          },
        ],
      });
      expect(afterValidation.tasks.map((task) => task.nodeId)).toEqual([authorId, validationId, repairId]);
    }
  });
});

describe("Trellis runtime", () => {
  test(
    "rejects unpinned, mismatched, and non-reactive runtime policy",
    async () => {
      const cases = [
        {
          name: "unpinned",
          options: { input: {}, requireRerenderOnOutputChange: true },
          expected: "explicitly pinned run maxConcurrency",
        },
        {
          name: "mismatched",
          options: { input: {}, maxConcurrency: 1, requireRerenderOnOutputChange: true },
          expected: "must equal the explicitly pinned run maxConcurrency",
        },
        {
          name: "non-reactive",
          options: { input: {}, maxConcurrency: 2, requireRerenderOnOutputChange: false },
          expected: "requires requireRerenderOnOutputChange=true",
        },
      ];

      for (const policyCase of cases) {
        const { Workflow, smithers, outputs, cleanup } = createTestSmithers(delegationV2Schemas);
        let agentCalls = 0;
        const agent = {
          id: `policy-${policyCase.name}`,
          tools: {},
          generate: async () => {
            agentCalls += 1;
            return { output: completeEnvelope("synthesize") };
          },
        };
        try {
          const workflow = smithers(() => (
            <Workflow name={`trellis-policy-${policyCase.name}`}>
              <Trellis
                prompt="Enforce runtime policy."
                goal={goal}
                acceptance={[criterion]}
                agents={{ sol: agent, fable: agent, terra: agent, luna: agent }}
                outputs={outputs}
                maxConcurrency={2}
              />
            </Workflow>
          ));
          const result = await Effect.runPromise(runWorkflow(workflow, policyCase.options));
          expect(result.status).toBe("failed");
          expect(failureText(result.error)).toContain(policyCase.expected);
          expect(agentCalls).toBe(0);
        } finally {
          cleanup();
        }
      }
    },
    RUNTIME_TEST_TIMEOUT_MS,
  );

  test(
    "executes a direct worker, continues the author, and never persists the speculative fallback",
    async () => {
      const { Workflow, smithers, outputs, tables, db, cleanup } = createTestSmithers(delegationV2Schemas);
      try {
        const authored = program(agentNode("inspect"), [{ from: "inspect", contract: "evidence_collection" }]);
        let authorCalls = 0;
        let continuationPrompt;
        const author = {
          id: "author",
          tools: {},
          generate: async ({ prompt }) => {
            authorCalls += 1;
            if (prompt.includes("Initial author assignment")) return { output: subworkflowEnvelope(authored) };
            if (prompt.includes("Author continuation")) {
              continuationPrompt = prompt;
              return { output: completeEnvelope("synthesize", "The worker evidence proves the root goal.") };
            }
            throw new Error("Unexpected author prompt.");
          },
        };
        let workerCalls = 0;
        const worker = {
          id: "worker",
          tools: {},
          generate: async () => {
            workerCalls += 1;
            return { output: workerEnvelope("research", "The requested evidence was collected.") };
          },
        };
        const workflow = smithers(() => (
          <Workflow name="trellis-direct">
            <Trellis
              prompt="Produce a verified answer."
              goal={goal}
              acceptance={[criterion]}
              agents={{ sol: author, fable: author, terra: worker, luna: worker }}
              outputs={outputs}
              maxConcurrency={2}
            />
          </Workflow>
        ));
        const result = await Effect.runPromise(
          runWorkflow(workflow, {
            input: {},
            maxConcurrency: 2,
            requireRerenderOnOutputChange: true,
          }),
        );
        expect(result.status).toBe("finished");
        expect(authorCalls).toBe(2);
        expect(workerCalls).toBe(1);
        expect(continuationPrompt).toContain("NEW SETTLED EVIDENCE");
        expect(continuationPrompt).toContain('"outputContract": "evidence_collection"');
        expect(continuationPrompt).toContain('"summary": "The requested evidence was collected."');
        expect(continuationPrompt).toMatch(/"assignmentDigest": "[a-f0-9]{64}"/);
        const outcomes = db.select().from(tables.dv2Outcome).all();
        expect(outcomes.some((row) => row.status === "runtime_failed")).toBe(false);
        expect(outcomes.map((row) => row.logicalId).sort()).toEqual(["inspect", "root"]);
        const finals = db.select().from(tables.dv2Final).all();
        expect(finals).toHaveLength(1);
        expect(finals[0].status).toBe("complete");

        const resumed = await Effect.runPromise(
          runWorkflow(workflow, {
            input: {},
            runId: result.runId,
            resume: true,
            maxConcurrency: 2,
            requireRerenderOnOutputChange: true,
          }),
        );
        expect(resumed.status).toBe("finished");
        expect(authorCalls).toBe(2);
        expect(workerCalls).toBe(1);
      } finally {
        cleanup();
      }
    },
    RUNTIME_TEST_TIMEOUT_MS,
  );

  test(
    "enforces the root concurrency cap across authored fan-out",
    async () => {
      const { Workflow, smithers, outputs, cleanup } = createTestSmithers(delegationV2Schemas);
      try {
        const branches = ["one", "two", "three", "four"].map((id) => agentNode(id));
        const authored = program(
          { tag: "parallel", id: "wave", branches, maxConcurrency: 2 },
          branches.map((branch) => ({ from: branch.id, contract: "evidence_collection" })),
        );
        const author = {
          id: "fanout-author",
          tools: {},
          generate: async ({ prompt }) => ({
            output: prompt.includes("Initial author assignment")
              ? subworkflowEnvelope(authored)
              : completeEnvelope("synthesize", "All four independent findings are settled."),
          }),
        };
        let active = 0;
        let peak = 0;
        let calls = 0;
        const worker = {
          id: "bounded-worker",
          tools: {},
          generate: async () => {
            calls += 1;
            active += 1;
            peak = Math.max(peak, active);
            await new Promise((resolve) => setTimeout(resolve, 40));
            active -= 1;
            return { output: workerEnvelope("research") };
          },
        };
        const workflow = smithers(() => (
          <Workflow name="trellis-fanout">
            <Trellis
              prompt="Fan out safely."
              goal={goal}
              acceptance={[criterion]}
              agents={{ sol: author, fable: author, terra: worker, luna: worker }}
              outputs={outputs}
              maxConcurrency={2}
            />
          </Workflow>
        ));
        const result = await Effect.runPromise(
          runWorkflow(workflow, {
            input: {},
            maxConcurrency: 2,
            requireRerenderOnOutputChange: true,
          }),
        );
        expect(result.status).toBe("finished");
        expect(calls).toBe(4);
        expect(peak).toBe(2);
      } finally {
        cleanup();
      }
    },
    RUNTIME_TEST_TIMEOUT_MS,
  );

  test(
    "recursively lets a Sol author delegate a bounded subworkflow to Fable",
    async () => {
      const { Workflow, smithers, outputs, tables, db, cleanup } = createTestSmithers(delegationV2Schemas);
      try {
        const nestedLeaf = program(agentNode("gather"), [{ from: "gather", contract: "evidence_collection" }]);
        const rootFragment = program(
          agentNode("architect", {
            role: "fable",
            work: "plan",
            prompt: { instructions: "Own the bounded plan and delegate its evidence gathering.", contextRefs: [] },
            outputContract: "plan",
          }),
          [{ from: "architect", contract: "plan" }],
        );
        let solCalls = 0;
        let fableCalls = 0;
        const sol = {
          id: "sol-author",
          tools: {},
          generate: async ({ prompt }) => {
            solCalls += 1;
            return {
              output: prompt.includes("Initial author assignment")
                ? subworkflowEnvelope(rootFragment)
                : completeEnvelope("synthesize", "The delegated Fable plan proves the root goal."),
            };
          },
        };
        const fable = {
          id: "fable-author",
          tools: {},
          generate: async ({ prompt }) => {
            fableCalls += 1;
            return {
              output: prompt.includes("Initial author assignment")
                ? subworkflowEnvelope(nestedLeaf)
                : completeEnvelope("plan", "The bounded plan is supported by child evidence."),
            };
          },
        };
        const worker = {
          id: "nested-worker",
          tools: {},
          generate: async () => ({ output: workerEnvelope("research") }),
        };
        const workflow = smithers(() => (
          <Workflow name="trellis-recursive">
            <Trellis
              prompt="Delegate recursively."
              goal={goal}
              acceptance={[criterion]}
              agents={{ sol, fable, terra: worker, luna: worker }}
              outputs={outputs}
              maxConcurrency={2}
            />
          </Workflow>
        ));
        const result = await Effect.runPromise(
          runWorkflow(workflow, {
            input: {},
            maxConcurrency: 2,
            requireRerenderOnOutputChange: true,
          }),
        );
        expect(result.status).toBe("finished");
        expect(solCalls).toBe(2);
        expect(fableCalls).toBe(2);
        const outcomes = db.select().from(tables.dv2Outcome).all();
        expect(outcomes.map((row) => row.logicalId).sort()).toEqual(["architect", "gather", "root"]);
        expect(db.select().from(tables.dv2Final).all()[0].status).toBe("complete");
      } finally {
        cleanup();
      }
    },
    RUNTIME_TEST_TIMEOUT_MS,
  );

  test(
    "partitions global author fuel across recursive sibling authors",
    async () => {
      const { Workflow, smithers, outputs, tables, db, cleanup } = createTestSmithers(delegationV2Schemas);
      try {
        const sibling = (id) =>
          agentNode(id, {
            role: "fable",
            work: "plan",
            prompt: { instructions: `Own the bounded ${id} planning slice.`, contextRefs: [] },
            outputContract: "plan",
          });
        const rootFragment = program(
          {
            tag: "sequence",
            id: "author-siblings",
            steps: [sibling("alpha"), sibling("beta")],
          },
          [
            { from: "alpha", contract: "plan" },
            { from: "beta", contract: "plan" },
          ],
        );
        const forbiddenGrandchild = program(agentNode("grandchild"), [
          { from: "grandchild", contract: "evidence_collection" },
        ]);
        let solCalls = 0;
        let fableCalls = 0;
        let workerCalls = 0;
        const sol = {
          id: "fuel-root-author",
          tools: {},
          generate: async ({ prompt }) => {
            solCalls += 1;
            return {
              output: prompt.includes("Initial author assignment")
                ? subworkflowEnvelope(rootFragment)
                : completeEnvelope("synthesize", "Both bounded child attempts are explicitly settled."),
            };
          },
        };
        const fable = {
          id: "fuel-child-author",
          tools: {},
          generate: async () => {
            fableCalls += 1;
            return { output: subworkflowEnvelope(forbiddenGrandchild) };
          },
        };
        const worker = {
          id: "fuel-grandchild-worker",
          tools: {},
          generate: async () => {
            workerCalls += 1;
            return { output: workerEnvelope("research") };
          },
        };
        const workflow = smithers(() => (
          <Workflow name="trellis-global-author-fuel">
            <Trellis
              prompt="Partition recursive work."
              goal={goal}
              acceptance={[criterion]}
              agents={{ sol, fable, terra: worker, luna: worker }}
              outputs={outputs}
              maxConcurrency={2}
              limits={{ maxTotalAuthorTurns: 5 }}
            />
          </Workflow>
        ));
        const result = await Effect.runPromise(
          runWorkflow(workflow, {
            input: {},
            maxConcurrency: 2,
            requireRerenderOnOutputChange: true,
          }),
        );
        expect(result.status).toBe("finished");
        expect(solCalls).toBe(2);
        expect(fableCalls).toBe(2);
        expect(solCalls + fableCalls).toBeLessThanOrEqual(5);
        expect(workerCalls).toBe(0);
        expect(db.select().from(tables.dv2Author).all()).toHaveLength(4);
        expect(db.select().from(tables.dv2Worker).all()).toHaveLength(0);
        const childOutcomes = db
          .select()
          .from(tables.dv2Outcome)
          .all()
          .filter((row) => row.logicalId === "alpha" || row.logicalId === "beta");
        expect(childOutcomes).toHaveLength(2);
        expect(childOutcomes.every((row) => row.runtimeFailure?.code === "budget_exhausted")).toBe(true);
        expect(db.select().from(tables.dv2Final).all()[0].status).toBe("complete");
      } finally {
        cleanup();
      }
    },
    RUNTIME_TEST_TIMEOUT_MS,
  );

  test(
    "settles a schema-valid but assignment-invalid worker claim before continuation",
    async () => {
      const { Workflow, smithers, outputs, tables, db, cleanup } = createTestSmithers(delegationV2Schemas);
      try {
        const assignedCriterion = {
          id: "source-verified",
          requirement: "Verify the assigned source.",
          verification: "Inspect source evidence.",
        };
        const authored = program(
          agentNode("misreported", {
            acceptance: [assignedCriterion],
          }),
          [{ from: "misreported", contract: "evidence_collection" }],
        );
        let continuationPrompt;
        const author = {
          id: "settlement-author",
          tools: {},
          generate: async ({ prompt }) => {
            if (prompt.includes("Initial author assignment")) return { output: subworkflowEnvelope(authored) };
            continuationPrompt = prompt;
            return { output: completeEnvelope("synthesize", "The invalid claim was rejected and made explicit.") };
          },
        };
        const worker = {
          id: "assignment-invalid-worker",
          tools: {},
          // The envelope schema accepts any local criterion id. Trusted assignment
          // settlement must reject that it judged `done` instead of `source-verified`.
          generate: async () => ({ output: workerEnvelope("research", "A syntactically valid but misbound claim.") }),
        };
        const workflow = smithers(() => (
          <Workflow name="trellis-assignment-settlement">
            <Trellis
              prompt="Reject misbound evidence."
              goal={goal}
              acceptance={[criterion]}
              agents={{ sol: author, fable: author, terra: worker, luna: worker }}
              outputs={outputs}
              maxConcurrency={2}
            />
          </Workflow>
        ));
        const result = await Effect.runPromise(
          runWorkflow(workflow, {
            input: {},
            maxConcurrency: 2,
            requireRerenderOnOutputChange: true,
          }),
        );
        expect(result.status).toBe("finished");
        const invalid = db
          .select()
          .from(tables.dv2Outcome)
          .all()
          .find((row) => row.logicalId === "misreported");
        expect(invalid.status).toBe("runtime_failed");
        expect(invalid.runtimeFailure.code).toBe("invalid_return");
        expect(invalid.runtimeFailure.message).toContain("assignment settlement");
        expect(continuationPrompt).toContain('"logicalId": "misreported"');
        expect(continuationPrompt).toContain('"code": "invalid_return"');
        expect(db.select().from(tables.dv2Final).all()[0].status).toBe("complete");
      } finally {
        cleanup();
      }
    },
    RUNTIME_TEST_TIMEOUT_MS,
  );

  test(
    "turns a failed worker into parent-visible runtime evidence and continues",
    async () => {
      const { Workflow, smithers, outputs, tables, db, cleanup } = createTestSmithers(delegationV2Schemas);
      try {
        const authored = program(agentNode("unstable"), [{ from: "unstable", contract: "evidence_collection" }]);
        const author = {
          id: "failure-author",
          tools: {},
          generate: async ({ prompt }) => ({
            output: prompt.includes("Initial author assignment")
              ? subworkflowEnvelope(authored)
              : completeEnvelope(
                  "synthesize",
                  "The failure is explicit evidence; the safe fallback still satisfies the goal.",
                ),
          }),
        };
        let workerCalls = 0;
        const worker = {
          id: "failing-worker",
          tools: {},
          generate: async () => {
            workerCalls += 1;
            throw new Error("deterministic worker failure");
          },
        };
        const workflow = smithers(() => (
          <Workflow name="trellis-worker-failure">
            <Trellis
              prompt="Continue through local failure."
              goal={goal}
              acceptance={[criterion]}
              agents={{ sol: author, fable: author, terra: worker, luna: worker }}
              outputs={outputs}
              maxConcurrency={2}
            />
          </Workflow>
        ));
        const result = await Effect.runPromise(
          runWorkflow(workflow, {
            input: {},
            maxConcurrency: 2,
            requireRerenderOnOutputChange: true,
          }),
        );
        expect(result.status).toBe("finished");
        expect(workerCalls).toBe(2);
        const outcomes = db.select().from(tables.dv2Outcome).all();
        const failedWorker = outcomes.find((row) => row.logicalId === "unstable");
        expect(failedWorker.status).toBe("runtime_failed");
        expect(failedWorker.runtimeFailure.code).toBe("crash");
        expect(outcomes.find((row) => row.logicalId === "root").status).toBe("complete");
        expect(db.select().from(tables.dv2Final).all()[0].status).toBe("complete");
      } finally {
        cleanup();
      }
    },
    RUNTIME_TEST_TIMEOUT_MS,
  );

  test(
    "permits one exact semantic repair and rejects graph growth after fuel exhaustion",
    async () => {
      const { Workflow, smithers, outputs, tables, db, cleanup } = createTestSmithers(delegationV2Schemas);
      try {
        const rejected = program(agentNode("inspect", { work: "plan" }), [
          { from: "inspect", contract: "evidence_collection" },
        ]);
        const corrected = {
          ...program(agentNode("inspect"), [{ from: "inspect", contract: "evidence_collection" }]),
          supersedes: { id: rejected.id, digest: delegationV2ProgramDigest(rejected) },
        };
        const author = {
          id: "repair-author",
          tools: {},
          generate: async ({ prompt }) => {
            if (prompt.includes("One-shot semantic IR repair")) return { output: subworkflowEnvelope(corrected) };
            if (prompt.includes("Initial author assignment")) return { output: subworkflowEnvelope(rejected) };
            return { output: completeEnvelope("synthesize", "The repaired fragment proves the goal.") };
          },
        };
        const worker = {
          id: "repair-worker",
          tools: {},
          generate: async () => ({ output: workerEnvelope("research") }),
        };
        const workflow = smithers(() => (
          <Workflow name="trellis-repair">
            <Trellis
              prompt="Repair only the invalid IR."
              goal={goal}
              acceptance={[criterion]}
              agents={{ sol: author, fable: author, terra: worker, luna: worker }}
              outputs={outputs}
              maxConcurrency={2}
            />
          </Workflow>
        ));
        const result = await Effect.runPromise(
          runWorkflow(workflow, {
            input: {},
            maxConcurrency: 2,
            requireRerenderOnOutputChange: true,
          }),
        );
        expect(result.status).toBe("finished");
        expect(
          db
            .select()
            .from(tables.dv2Validation)
            .all()
            .map((row) => row.status)
            .sort(),
        ).toEqual(["accepted", "rejected"]);
        expect(db.select().from(tables.dv2Worker).all()).toHaveLength(1);
        expect(db.select().from(tables.dv2Final).all()[0].status).toBe("complete");
      } finally {
        cleanup();
      }
    },
    RUNTIME_TEST_TIMEOUT_MS,
  );

  test(
    "repairs raw IR without mistaking normalized whitespace for a broader edit",
    async () => {
      const { Workflow, smithers, outputs, tables, db, cleanup } = createTestSmithers(delegationV2Schemas);
      try {
        const valid = program(
          agentNode("inspect", {
            prompt: { instructions: "  Investigate inspect while preserving the raw proposal.  ", contextRefs: [] },
          }),
          [{ from: "inspect", contract: "evidence_collection" }],
        );
        const rejected = { ...valid, root: { ...valid.root, injectedTool: "shell" } };
        const rejection = validateWorkflowProgram(rejected, { rootMaxConcurrency: 2 });
        expect(rejection.status).toBe("rejected");
        const corrected = {
          ...valid,
          supersedes: { id: rejected.id, digest: rejection.programDigest },
        };
        let authorCalls = 0;
        const author = {
          id: "raw-repair-author",
          tools: {},
          generate: async ({ prompt }) => {
            authorCalls += 1;
            if (prompt.includes("One-shot semantic IR repair")) return { output: subworkflowEnvelope(corrected) };
            if (prompt.includes("Initial author assignment")) return { output: subworkflowEnvelope(rejected) };
            return {
              output: completeEnvelope(
                "synthesize",
                "The bounded schema repair preserved and completed the original plan.",
              ),
            };
          },
        };
        const worker = {
          id: "raw-repair-worker",
          tools: {},
          generate: async () => ({ output: workerEnvelope("research") }),
        };
        const workflow = smithers(() => (
          <Workflow name="trellis-raw-schema-repair">
            <Trellis
              prompt="Repair malformed IR without replanning."
              goal={goal}
              acceptance={[criterion]}
              agents={{ sol: author, fable: author, terra: worker, luna: worker }}
              outputs={outputs}
              maxConcurrency={2}
            />
          </Workflow>
        ));
        const result = await Effect.runPromise(
          runWorkflow(workflow, {
            input: {},
            maxConcurrency: 2,
            requireRerenderOnOutputChange: true,
          }),
        );
        expect(result.status).toBe("finished");
        expect(authorCalls).toBe(3);
        expect(
          db
            .select()
            .from(tables.dv2Validation)
            .all()
            .map((row) => row.status)
            .sort(),
        ).toEqual(["accepted", "rejected"]);
        expect(db.select().from(tables.dv2Worker).all()).toHaveLength(1);
        expect(db.select().from(tables.dv2Final).all()[0].status).toBe("complete");
      } finally {
        cleanup();
      }
    },
    RUNTIME_TEST_TIMEOUT_MS,
  );

  test(
    "rejects a semantic repair that substitutes an unrelated valid program",
    async () => {
      const { Workflow, smithers, outputs, tables, db, cleanup } = createTestSmithers(delegationV2Schemas);
      try {
        const rejected = program(agentNode("inspect", { work: "plan" }), [
          { from: "inspect", contract: "evidence_collection" },
        ]);
        const replacementBase = program(agentNode("unrelated"), [
          { from: "unrelated", contract: "evidence_collection" },
        ]);
        const replacement = {
          ...replacementBase,
          supersedes: { id: rejected.id, digest: delegationV2ProgramDigest(rejected) },
        };
        let workerCalls = 0;
        const author = {
          id: "replacement-repair-author",
          tools: {},
          generate: async ({ prompt }) => ({
            output: prompt.includes("One-shot semantic IR repair")
              ? subworkflowEnvelope(replacement)
              : subworkflowEnvelope(rejected),
          }),
        };
        const worker = {
          id: "replacement-repair-worker",
          tools: {},
          generate: async () => {
            workerCalls += 1;
            return { output: workerEnvelope("research") };
          },
        };
        const workflow = smithers(() => (
          <Workflow name="trellis-reject-replanning-repair">
            <Trellis
              prompt="Reject repair-time replanning."
              goal={goal}
              acceptance={[criterion]}
              agents={{ sol: author, fable: author, terra: worker, luna: worker }}
              outputs={outputs}
              maxConcurrency={2}
            />
          </Workflow>
        ));
        const result = await Effect.runPromise(
          runWorkflow(workflow, {
            input: {},
            maxConcurrency: 2,
            requireRerenderOnOutputChange: true,
          }),
        );
        expect(result.status).toBe("finished");
        expect(workerCalls).toBe(0);
        expect(
          db
            .select()
            .from(tables.dv2Validation)
            .all()
            .map((row) => row.status),
        ).toEqual(["rejected", "rejected"]);
        const final = db.select().from(tables.dv2Final).all()[0];
        expect(final.status).toBe("runtime_failed");
        expect(final.outcome.runtimeFailure.code).toBe("invalid_subworkflow");
      } finally {
        cleanup();
      }
    },
    RUNTIME_TEST_TIMEOUT_MS,
  );

  test(
    "does not mount semantic repair when only one author turn remains",
    async () => {
      const { Workflow, smithers, outputs, tables, db, cleanup } = createTestSmithers(delegationV2Schemas);
      try {
        const rejected = program(agentNode("inspect", { work: "plan" }), [
          { from: "inspect", contract: "evidence_collection" },
        ]);
        let authorCalls = 0;
        const author = {
          id: "low-fuel-repair-author",
          tools: {},
          generate: async ({ prompt }) => {
            authorCalls += 1;
            if (prompt.includes("One-shot semantic IR repair")) {
              throw new Error("repair must not be mounted without continuation fuel");
            }
            return { output: subworkflowEnvelope(rejected) };
          },
        };
        const worker = {
          id: "low-fuel-worker",
          tools: {},
          generate: async () => ({ output: workerEnvelope("research") }),
        };
        const workflow = smithers(() => (
          <Workflow name="trellis-low-fuel-repair">
            <Trellis
              prompt="Do not overdraw repair fuel."
              goal={goal}
              acceptance={[criterion]}
              agents={{ sol: author, fable: author, terra: worker, luna: worker }}
              outputs={outputs}
              maxConcurrency={2}
              limits={{ maxTotalAuthorTurns: 2 }}
            />
          </Workflow>
        ));
        const result = await Effect.runPromise(
          runWorkflow(workflow, {
            input: {},
            maxConcurrency: 2,
            requireRerenderOnOutputChange: true,
          }),
        );
        expect(result.status).toBe("finished");
        expect(authorCalls).toBe(1);
        expect(db.select().from(tables.dv2Author).all()).toHaveLength(1);
        expect(
          db
            .select()
            .from(tables.dv2Validation)
            .all()
            .map((row) => row.status),
        ).toEqual(["rejected"]);
        expect(db.select().from(tables.dv2Worker).all()).toHaveLength(0);
        const final = db.select().from(tables.dv2Final).all()[0];
        expect(final.status).toBe("fuel_exhausted");
        expect(final.outcome.runtimeFailure.code).toBe("budget_exhausted");
      } finally {
        cleanup();
      }
    },
    RUNTIME_TEST_TIMEOUT_MS,
  );

  test(
    "settles deterministically with fuel_exhausted when an author keeps growing the graph",
    async () => {
      const { Workflow, smithers, outputs, tables, db, cleanup } = createTestSmithers(delegationV2Schemas);
      try {
        const authored = program(agentNode("inspect"), [{ from: "inspect", contract: "evidence_collection" }]);
        let authorCalls = 0;
        const author = {
          id: "unbounded-author",
          tools: {},
          generate: async () => {
            authorCalls += 1;
            return { output: subworkflowEnvelope(authored) };
          },
        };
        const worker = { id: "fuel-worker", tools: {}, generate: async () => ({ output: workerEnvelope("research") }) };
        const workflow = smithers(() => (
          <Workflow name="trellis-fuel">
            <Trellis
              prompt="Bound recursive growth."
              goal={goal}
              acceptance={[criterion]}
              agents={{ sol: author, fable: author, terra: worker, luna: worker }}
              outputs={outputs}
              maxConcurrency={2}
              limits={{ maxAuthorGenerations: 2 }}
            />
          </Workflow>
        ));
        const result = await Effect.runPromise(
          runWorkflow(workflow, {
            input: {},
            maxConcurrency: 2,
            requireRerenderOnOutputChange: true,
          }),
        );
        expect(result.status).toBe("finished");
        expect(authorCalls).toBe(2);
        expect(db.select().from(tables.dv2Worker).all()).toHaveLength(1);
        const final = db.select().from(tables.dv2Final).all()[0];
        expect(final.status).toBe("fuel_exhausted");
        expect(final.outcome.runtimeFailure.code).toBe("budget_exhausted");
      } finally {
        cleanup();
      }
    },
    RUNTIME_TEST_TIMEOUT_MS,
  );
});
