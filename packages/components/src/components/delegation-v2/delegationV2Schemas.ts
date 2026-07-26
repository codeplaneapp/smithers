import { z } from "zod";

/** Wire versions are integers; registry/compiler versions are immutable runtime strings. */
export const DELEGATION_V2_PROTOCOL_VERSION = 2 as const;
export const DELEGATION_V2_PROGRAM_VERSION = 1 as const;
export const DELEGATION_V2_REGISTRY_VERSION = "delegation-v2.registry-2" as const;

const shortTextSchema = z.string().trim().min(1).max(512);
const textSchema = z.string().trim().min(1).max(12_000);
const versionSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const nonNegativeIntSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** Agent-authored IDs are deliberately narrower than gateway node IDs. */
export const localIdSchema = z
  .string()
  .min(1)
  .max(48)
  .regex(/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/);

export const gatewayNodeIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9:_-]+$/);

export const roleSchema = z.enum(["sol", "fable", "terra", "luna"]);
export type DelegationV2Role = z.infer<typeof roleSchema>;

export const workKindSchema = z.enum([
  "refine_goal",
  "plan",
  "research",
  "poc",
  "execute",
  "review",
  "preview",
  "synthesize",
]);
export type DelegationV2WorkKind = z.infer<typeof workKindSchema>;

export const outputContractIdSchema = z.enum([
  "work_product",
  "goal_contract",
  "plan",
  "evaluation",
  "classification",
  "issue_scan",
  "condition",
  "artifact_collection",
  "evidence_collection",
]);
export type OutputContractId = z.infer<typeof outputContractIdSchema>;

/**
 * Nominal output contracts accepted from each work playbook. The runtime uses
 * the same closed registry during IR validation and terminal settlement, so a
 * model cannot relabel arbitrary work as a more specific contract.
 */
export const DELEGATION_V2_OUTPUT_CONTRACTS_BY_WORK = Object.freeze({
  refine_goal: Object.freeze(["goal_contract", "work_product"]),
  plan: Object.freeze(["plan", "work_product"]),
  research: Object.freeze(["evidence_collection", "issue_scan", "classification", "condition", "work_product"]),
  poc: Object.freeze(["evaluation", "evidence_collection", "condition", "work_product"]),
  execute: Object.freeze(["artifact_collection", "work_product"]),
  review: Object.freeze(["evaluation", "issue_scan", "work_product"]),
  preview: Object.freeze(["evaluation", "artifact_collection", "work_product"]),
  synthesize: Object.freeze(["work_product"]),
} satisfies Record<DelegationV2WorkKind, readonly OutputContractId[]>);

export function delegationV2OutputContractAllowed(work: DelegationV2WorkKind, contract: OutputContractId): boolean {
  return DELEGATION_V2_OUTPUT_CONTRACTS_BY_WORK[work].includes(contract as never);
}

export const goalContractSchema = z.strictObject({
  objective: textSchema,
  context: z.array(shortTextSchema).max(24),
  constraints: z.array(shortTextSchema).max(24),
  nonGoals: z.array(shortTextSchema).max(16),
});
export type GoalContract = z.infer<typeof goalContractSchema>;

export const acceptanceCriterionSchema = z.strictObject({
  id: localIdSchema,
  requirement: shortTextSchema,
  verification: shortTextSchema,
});
export type AcceptanceCriterion = z.infer<typeof acceptanceCriterionSchema>;

export const inputRefSchema = z.strictObject({
  from: localIdSchema,
  contract: outputContractIdSchema,
  purpose: shortTextSchema,
});
export type InputRef = z.infer<typeof inputRefSchema>;

export const outputRefSchema = z.strictObject({
  from: localIdSchema,
  contract: outputContractIdSchema,
});
export type OutputRef = z.infer<typeof outputRefSchema>;

export const promptSpecSchema = z.strictObject({
  instructions: textSchema,
  contextRefs: z.array(localIdSchema).max(16),
});
export type PromptSpec = z.infer<typeof promptSpecSchema>;

export const criticalExecutionCategorySchema = z.enum([
  "security_boundary",
  "data_integrity",
  "concurrency_invariant",
  "protocol_core",
  "irreversible_migration",
]);
export type CriticalExecutionCategory = z.infer<typeof criticalExecutionCategorySchema>;

const criticalRelativePathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value === value.trim() && value.normalize("NFC") === value, "path must be normalized")
  .refine(
    (value) => !value.startsWith("/") && !value.startsWith("~") && !value.includes("\\"),
    "path must be workspace-relative POSIX syntax",
  )
  .refine(
    (value) => !/[\u0000-\u001f\u007f*?[\]{}]/.test(value),
    "path cannot contain control characters or glob syntax",
  )
  .refine(
    (value) => value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== ".."),
    "path cannot contain empty, '.' or '..' segments",
  );

/** Model request; trusted caller policy must separately admit every bound. */
export const criticalitySchema = z.strictObject({
  category: criticalExecutionCategorySchema,
  invariant: shortTextSchema,
  whyHighTierIsRequired: shortTextSchema,
  whyTheCoreCannotBeDelegated: shortTextSchema,
  allowedPaths: z.array(criticalRelativePathSchema).min(1).max(16),
  expectedChangedLines: z.number().int().min(1).max(500),
  lineSensitivity: shortTextSchema,
  surroundingWorkDelegatedTo: z.array(localIdSchema).max(16),
  reviewNodeId: localIdSchema,
});
export type Criticality = z.infer<typeof criticalitySchema>;

export const evidenceKindSchema = z.enum(["observation", "test", "source", "artifact", "analysis", "user_input"]);

export const evidenceSchema = z.strictObject({
  id: localIdSchema,
  kind: evidenceKindSchema,
  summary: shortTextSchema,
  locator: z.string().trim().min(1).max(2_048).optional(),
});
export type DelegationV2Evidence = z.infer<typeof evidenceSchema>;

export const artifactSchema = z.strictObject({
  id: localIdSchema,
  kind: z.enum(["file", "diff", "command_output", "url", "report", "preview", "other"]),
  locator: z.string().trim().min(1).max(2_048),
  summary: shortTextSchema,
});
export type DelegationV2Artifact = z.infer<typeof artifactSchema>;

export const acceptanceJudgmentSchema = z.strictObject({
  criterionId: localIdSchema,
  status: z.enum(["passed", "failed", "unknown"]),
  evidenceIds: z.array(localIdSchema).max(16),
  explanation: shortTextSchema,
});

export const riskSchema = z.strictObject({
  risk: shortTextSchema,
  impact: shortTextSchema,
  mitigation: shortTextSchema.optional(),
});

const detailSchemas = {
  refine_goal: z.strictObject({
    goal: goalContractSchema,
    refinedObjective: textSchema,
    unresolvedPreferences: z.array(shortTextSchema).max(16),
  }),
  plan: z.strictObject({ approach: textSchema, steps: z.array(shortTextSchema).min(1).max(32) }),
  research: z.strictObject({
    conclusion: textSchema,
    findings: z.array(shortTextSchema).max(32),
    classification: z.strictObject({ label: shortTextSchema, rationale: textSchema }).optional(),
    condition: z.strictObject({ state: z.enum(["met", "not_met", "unknown"]), rationale: textSchema }).optional(),
    issues: z.array(shortTextSchema).max(32).optional(),
  }),
  poc: z.strictObject({
    hypothesis: shortTextSchema,
    result: z.enum(["supported", "disproven", "inconclusive"]),
    observations: z.array(shortTextSchema).min(1).max(32),
    condition: z.strictObject({ state: z.enum(["met", "not_met", "unknown"]), rationale: textSchema }).optional(),
  }),
  execute: z.strictObject({ result: textSchema, verification: z.array(shortTextSchema).min(1).max(32) }),
  review: z.strictObject({ verdict: z.enum(["pass", "fail", "mixed"]), findings: z.array(shortTextSchema).max(32) }),
  preview: z.strictObject({
    verdict: z.enum(["pass", "fail", "partial"]),
    observations: z.array(shortTextSchema).max(32),
  }),
  synthesize: z.strictObject({ conclusion: textSchema, disagreements: z.array(shortTextSchema).max(16) }),
} as const;

const workProductBaseShape = {
  summary: textSchema,
  acceptance: z.array(acceptanceJudgmentSchema).min(1).max(32),
  evidence: z.array(evidenceSchema).max(64),
  artifacts: z.array(artifactSchema).max(32),
  assumptions: z.array(shortTextSchema).max(24),
  openRisks: z.array(riskSchema).max(24),
};

/** Build the exact product schema for the playbook assigned to one task. */
export function workProductSchemaFor<const W extends DelegationV2WorkKind>(work: W) {
  return z.strictObject({
    work: z.literal(work),
    ...workProductBaseShape,
    details: detailSchemas[work],
  });
}

const refineGoalProductSchema = workProductSchemaFor("refine_goal");
const planProductSchema = workProductSchemaFor("plan");
const researchProductSchema = workProductSchemaFor("research");
const pocProductSchema = workProductSchemaFor("poc");
const executeProductSchema = workProductSchemaFor("execute");
const reviewProductSchema = workProductSchemaFor("review");
const previewProductSchema = workProductSchemaFor("preview");
const synthesizeProductSchema = workProductSchemaFor("synthesize");

export const workProductSchema = z.discriminatedUnion("work", [
  refineGoalProductSchema,
  planProductSchema,
  researchProductSchema,
  pocProductSchema,
  executeProductSchema,
  reviewProductSchema,
  previewProductSchema,
  synthesizeProductSchema,
]);
export type WorkProduct = z.infer<typeof workProductSchema>;

const blockageBaseShape = {
  summary: textSchema,
  partialWork: textSchema,
  attemptedAlternatives: z.array(shortTextSchema).min(1).max(16),
  whyNoSafeFallbackExists: textSchema,
  requiredNextAction: shortTextSchema,
  evidence: z.array(evidenceSchema).max(32),
  openRisks: z.array(riskSchema).max(24),
};

export function blockedWorkSchemaFor<const W extends DelegationV2WorkKind>(work: W) {
  return z.strictObject({ work: z.literal(work), ...blockageBaseShape });
}

export const blockedWorkSchema = z.strictObject({ work: workKindSchema, ...blockageBaseShape });
export type BlockedWork = z.infer<typeof blockedWorkSchema>;

export type WorkflowAgentExpr = {
  tag: "agent";
  id: string;
  role: DelegationV2Role;
  work: DelegationV2WorkKind;
  goal: GoalContract;
  prompt: PromptSpec;
  inputs: InputRef[];
  acceptance: AcceptanceCriterion[];
  outputContract: OutputContractId;
  criticality?: Criticality;
};

export type WorkflowSequenceExpr = { tag: "sequence"; id: string; steps: WorkflowExpr[] };
export type WorkflowParallelExpr = {
  tag: "parallel";
  id: string;
  branches: WorkflowExpr[];
  maxConcurrency?: number;
};
export type WorkflowExpr = WorkflowAgentExpr | WorkflowSequenceExpr | WorkflowParallelExpr;

export const agentExprSchema = z.strictObject({
  tag: z.literal("agent"),
  id: localIdSchema,
  role: roleSchema,
  work: workKindSchema,
  goal: goalContractSchema,
  prompt: promptSpecSchema,
  inputs: z.array(inputRefSchema).max(16),
  acceptance: z.array(acceptanceCriterionSchema).min(1).max(32),
  outputContract: outputContractIdSchema,
  criticality: criticalitySchema.optional(),
});

export const workflowExprSchema = z.lazy(() =>
  z.discriminatedUnion("tag", [
    agentExprSchema,
    z.strictObject({
      tag: z.literal("sequence"),
      id: localIdSchema,
      steps: z.array(workflowExprSchema).min(1).max(32),
    }),
    z.strictObject({
      tag: z.literal("parallel"),
      id: localIdSchema,
      branches: z.array(workflowExprSchema).min(2).max(32),
      maxConcurrency: z.number().int().min(1).max(32).optional(),
    }),
  ]),
) as z.ZodType<WorkflowExpr>;

export const programRefSchema = z.strictObject({ id: localIdSchema, digest: digestSchema });

export const workflowProgramSchema = z.strictObject({
  schemaVersion: z.literal(DELEGATION_V2_PROGRAM_VERSION),
  registryVersion: versionSchema,
  id: localIdSchema,
  objective: goalContractSchema,
  rationale: textSchema,
  root: workflowExprSchema,
  outputs: z.array(outputRefSchema).min(1).max(16),
  supersedes: programRefSchema.optional(),
});
export type WorkflowProgram = z.infer<typeof workflowProgramSchema>;

/**
 * Author turns persist a proposal before the trusted semantic validator runs.
 * This capture boundary is intentionally shallower than WorkflowProgramV1:
 * malformed fields must survive long enough to receive one bounded repair, but
 * arbitrary JavaScript values and resource-exhaustion payloads must not.
 *
 * The limits are transport limits, not executable-graph limits. They are high
 * enough for the validator to diagnose an over-deep/over-wide proposal and low
 * enough that hashing, persistence, and repair prompting stay bounded.
 */
export const DELEGATION_V2_AUTHOR_CAPTURE_LIMITS = Object.freeze({
  maxDepth: 64,
  maxValues: 4_096,
  maxArrayLength: 256,
  maxBytes: 262_144,
});

/** @param {unknown} value */
function capturedJsonProblem(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "subworkflow.value must be a JSON object";
  }

  const stack: Array<{ value: unknown; depth: number; exit?: boolean }> = [{ value, depth: 1 }];
  const ancestors = new Set<object>();
  const encoder = new TextEncoder();
  let values = 0;
  let bytes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.exit) {
      ancestors.delete(current.value as object);
      continue;
    }
    values += 1;
    if (values > DELEGATION_V2_AUTHOR_CAPTURE_LIMITS.maxValues) {
      return `subworkflow.value exceeds ${DELEGATION_V2_AUTHOR_CAPTURE_LIMITS.maxValues} JSON values`;
    }
    if (current.depth > DELEGATION_V2_AUTHOR_CAPTURE_LIMITS.maxDepth) {
      return `subworkflow.value exceeds capture depth ${DELEGATION_V2_AUTHOR_CAPTURE_LIMITS.maxDepth}`;
    }

    const item = current.value;
    if (item === null) {
      bytes += 4;
    } else if (typeof item === "string") {
      bytes += encoder.encode(item).byteLength + 2;
    } else if (typeof item === "number") {
      if (!Number.isFinite(item)) return "subworkflow.value numbers must be finite";
      bytes += 24;
    } else if (typeof item === "boolean") {
      bytes += 5;
    } else if (typeof item !== "object") {
      return `subworkflow.value cannot contain ${typeof item}`;
    } else {
      if (ancestors.has(item)) return "subworkflow.value must be acyclic JSON data";
      ancestors.add(item);
      stack.push({ value: item, depth: current.depth, exit: true });
      const prototype = Object.getPrototypeOf(item);
      if (Array.isArray(item)) {
        if (item.length > DELEGATION_V2_AUTHOR_CAPTURE_LIMITS.maxArrayLength) {
          return `subworkflow.value arrays cannot exceed ${DELEGATION_V2_AUTHOR_CAPTURE_LIMITS.maxArrayLength} entries`;
        }
        bytes += item.length + 2;
        for (let index = item.length - 1; index >= 0; index -= 1) {
          if (!Object.hasOwn(item, index)) return "subworkflow.value cannot contain sparse arrays";
          stack.push({ value: item[index], depth: current.depth + 1 });
        }
      } else {
        if (prototype !== Object.prototype && prototype !== null) {
          return "subworkflow.value accepts only plain JSON objects and arrays";
        }
        const record = item as Record<string, unknown>;
        const descriptors = Object.getOwnPropertyDescriptors(record);
        for (const key of Object.keys(record)) {
          const descriptor = descriptors[key];
          if (!descriptor || descriptor.get || descriptor.set) {
            return "subworkflow.value cannot contain accessors";
          }
          bytes += encoder.encode(key).byteLength + 3;
          stack.push({ value: descriptor.value, depth: current.depth + 1 });
        }
      }
    }
    if (bytes > DELEGATION_V2_AUTHOR_CAPTURE_LIMITS.maxBytes) {
      return `subworkflow.value exceeds ${DELEGATION_V2_AUTHOR_CAPTURE_LIMITS.maxBytes} captured bytes`;
    }
  }
  return undefined;
}

/**
 * Strict outer capture for an author-proposed program. Known fields are kept in
 * the generated schema example, while their raw values and unknown keys are
 * preserved for the trusted validator. Nothing below this object is executed.
 */
export const capturedWorkflowProgramSchema = z
  .object({
    schemaVersion: z.unknown().optional().describe("WorkflowProgramV1 schemaVersion (must be 1)"),
    registryVersion: z.unknown().optional().describe("trusted delegation registry version"),
    id: z.unknown().optional().describe("stable local program id"),
    objective: z.unknown().optional().describe("closed GoalContract object"),
    rationale: z.unknown().optional().describe("bounded rationale string"),
    root: z.unknown().optional().describe("agent | sequence | parallel WorkflowExpr object"),
    outputs: z.unknown().optional().describe("non-empty array of declared output refs"),
    supersedes: z.unknown().optional().describe("optional exact prior program id/digest ref"),
  })
  .catchall(z.unknown())
  .superRefine((value, ctx) => {
    const problem = capturedJsonProblem(value);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  });
export type CapturedWorkflowProgram = z.infer<typeof capturedWorkflowProgramSchema>;

export const continuationStateSchema = z.strictObject({
  summary: textSchema,
  retainedFacts: z.array(shortTextSchema).max(32),
  openRisks: z.array(riskSchema).max(24),
});

const completeOutcomeSchema = z.strictObject({ tag: z.literal("complete"), value: workProductSchema });
const blockedOutcomeSchema = z.strictObject({ tag: z.literal("blocked"), value: blockedWorkSchema });
const subworkflowOutcomeSchema = z.strictObject({
  tag: z.literal("subworkflow"),
  value: capturedWorkflowProgramSchema,
});

export const authorEnvelopeSchema = z.strictObject({
  protocolVersion: z.literal(DELEGATION_V2_PROTOCOL_VERSION),
  outcome: z.discriminatedUnion("tag", [subworkflowOutcomeSchema, completeOutcomeSchema, blockedOutcomeSchema]),
  state: continuationStateSchema,
});
export type AuthorEnvelope = z.infer<typeof authorEnvelopeSchema>;

/** Work-specific author schema used to prevent a complete/blocked shape from changing playbooks. */
export function authorEnvelopeSchemaFor<const W extends DelegationV2WorkKind>(work: W) {
  return z.strictObject({
    protocolVersion: z.literal(DELEGATION_V2_PROTOCOL_VERSION),
    outcome: z.discriminatedUnion("tag", [
      subworkflowOutcomeSchema,
      z.strictObject({ tag: z.literal("complete"), value: workProductSchemaFor(work) }),
      z.strictObject({ tag: z.literal("blocked"), value: blockedWorkSchemaFor(work) }),
    ]),
    state: continuationStateSchema,
  });
}

export const workerEnvelopeSchema = z.strictObject({
  protocolVersion: z.literal(DELEGATION_V2_PROTOCOL_VERSION),
  outcome: z.discriminatedUnion("tag", [completeOutcomeSchema, blockedOutcomeSchema]),
});
export type WorkerEnvelope = z.infer<typeof workerEnvelopeSchema>;

/** Terra/Luna tasks always use this builder; its union has no graph-producing variant. */
export function workerEnvelopeSchemaFor<const W extends DelegationV2WorkKind>(work: W) {
  return z.strictObject({
    protocolVersion: z.literal(DELEGATION_V2_PROTOCOL_VERSION),
    outcome: z.discriminatedUnion("tag", [
      z.strictObject({ tag: z.literal("complete"), value: workProductSchemaFor(work) }),
      z.strictObject({ tag: z.literal("blocked"), value: blockedWorkSchemaFor(work) }),
    ]),
  });
}

export const questionChoiceSchema = z.strictObject({
  id: localIdSchema,
  label: shortTextSchema,
  description: shortTextSchema,
});

/** Nonblocking ask-question tool payload. Runtime identity is attached outside model output. */
export const dv2QuestionSchema = z.strictObject({
  key: localIdSchema,
  target: z.enum(["parent", "human"]),
  question: shortTextSchema,
  whyItMatters: shortTextSchema,
  fallbackAssumption: shortTextSchema,
  impactIfWrong: shortTextSchema,
  choices: z.array(questionChoiceSchema).min(2).max(8).optional(),
});

export const dv2AnswerSchema = z.strictObject({
  key: localIdSchema,
  source: z.enum(["parent", "human"]),
  answer: textSchema,
  answeredAtMs: nonNegativeIntSchema,
  replacesFallback: z.boolean(),
});

export const validationDiagnosticCodeSchema = z.enum([
  "schema_invalid",
  "registry_mismatch",
  "duplicate_id",
  "reserved_id",
  "node_limit",
  "depth_limit",
  "fanout_limit",
  "concurrency_limit",
  "unsupported_nested_concurrency",
  "prompt_limit",
  "total_prompt_limit",
  "author_fuel_limit",
  "role_work_forbidden",
  "acceptance_duplicate",
  "author_depth_limit",
  "criticality_required",
  "criticality_forbidden",
  "criticality_ungranted",
  "criticality_policy_mismatch",
  "critical_review_missing",
  "critical_review_invalid",
  "critical_review_not_independent",
  "critical_review_not_joined",
  "reference_missing",
  "reference_forward",
  "reference_contract_mismatch",
  "parallel_sibling_reference",
  "prompt_context_missing",
  "output_missing",
  "output_contract_mismatch",
  "output_contract_forbidden",
  "output_duplicate",
  "parallel_write_conflict",
]);

export const validationDiagnosticSchema = z.strictObject({
  code: validationDiagnosticCodeSchema,
  path: z.string().min(1).max(512),
  message: z.string().min(1).max(2_048),
  nodeId: localIdSchema.optional(),
});

export const validationStatsSchema = z.strictObject({
  nodes: nonNegativeIntSchema,
  agents: nonNegativeIntSchema,
  authors: nonNegativeIntSchema,
  maxDepth: nonNegativeIntSchema,
  maxFanout: nonNegativeIntSchema,
  totalPromptBytes: nonNegativeIntSchema,
});

/** Trusted validation row. Rejected programs retain a digest but never normalized IR. */
export const dv2ValidationSchema = z
  .strictObject({
    invocationKey: gatewayNodeIdSchema,
    generation: nonNegativeIntSchema,
    authorNodeId: gatewayNodeIdSchema,
    status: z.enum(["accepted", "rejected"]),
    programDigest: digestSchema,
    registryVersion: versionSchema,
    compilerVersion: versionSchema,
    criticalExecutionPolicyHash: digestSchema.optional(),
    normalizedProgram: workflowProgramSchema.optional(),
    diagnostics: z.array(validationDiagnosticSchema).max(128),
    stats: validationStatsSchema.optional(),
  })
  .superRefine((row, ctx) => {
    if (row.status === "accepted" && !row.normalizedProgram) {
      ctx.addIssue({
        code: "custom",
        path: ["normalizedProgram"],
        message: "accepted validation requires normalizedProgram",
      });
    }
    if (row.status === "rejected" && row.normalizedProgram) {
      ctx.addIssue({
        code: "custom",
        path: ["normalizedProgram"],
        message: "rejected validation must not persist normalizedProgram",
      });
    }
    if (row.status === "rejected" && row.diagnostics.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["diagnostics"],
        message: "rejected validation requires at least one diagnostic",
      });
    }
    if (row.normalizedProgram && row.normalizedProgram.registryVersion !== row.registryVersion) {
      ctx.addIssue({
        code: "custom",
        path: ["registryVersion"],
        message: "row registryVersion must match normalizedProgram",
      });
    }
  });

export const runtimeFailureSchema = z.strictObject({
  code: z.enum(["crash", "timeout", "invalid_return", "cancelled", "budget_exhausted", "invalid_subworkflow"]),
  message: z.string().min(1).max(2_048),
});

/** Uniform trusted settlement row consumed by author continuations. */
export const dv2OutcomeSchema = z
  .strictObject({
    invocationKey: gatewayNodeIdSchema,
    logicalId: localIdSchema,
    generation: nonNegativeIntSchema,
    role: roleSchema,
    work: workKindSchema,
    outputContract: outputContractIdSchema,
    assignmentDigest: digestSchema,
    acceptanceCriterionIds: z.array(localIdSchema).min(1).max(32),
    status: z.enum(["complete", "blocked", "runtime_failed"]),
    sourceNodeId: gatewayNodeIdSchema,
    programDigest: digestSchema.optional(),
    product: workProductSchema.optional(),
    blockage: blockedWorkSchema.optional(),
    runtimeFailure: runtimeFailureSchema.optional(),
  })
  .superRefine((row, ctx) => {
    if (!delegationV2OutputContractAllowed(row.work, row.outputContract)) {
      ctx.addIssue({
        code: "custom",
        path: ["outputContract"],
        message: `${row.work} cannot settle ${row.outputContract}`,
      });
    }
    const expectedCriterionIds = new Set(row.acceptanceCriterionIds);
    if (expectedCriterionIds.size !== row.acceptanceCriterionIds.length) {
      ctx.addIssue({
        code: "custom",
        path: ["acceptanceCriterionIds"],
        message: "assigned acceptance criterion ids must be unique",
      });
    }
    const expected = row.status === "complete" ? "product" : row.status === "blocked" ? "blockage" : "runtimeFailure";
    for (const field of ["product", "blockage", "runtimeFailure"] as const) {
      if (field === expected && !row[field]) {
        ctx.addIssue({ code: "custom", path: [field], message: `${row.status} outcome requires ${field}` });
      } else if (field !== expected && row[field]) {
        ctx.addIssue({ code: "custom", path: [field], message: `${row.status} outcome cannot contain ${field}` });
      }
    }
    if (row.product && row.product.work !== row.work) {
      ctx.addIssue({ code: "custom", path: ["product", "work"], message: "product work must match outcome work" });
    }
    if (row.product) {
      const judgments = new Map<string, number>();
      for (const [index, judgment] of row.product.acceptance.entries()) {
        judgments.set(judgment.criterionId, (judgments.get(judgment.criterionId) ?? 0) + 1);
        if (!expectedCriterionIds.has(judgment.criterionId)) {
          ctx.addIssue({
            code: "custom",
            path: ["product", "acceptance", index, "criterionId"],
            message: "judgment is not part of the assigned acceptance contract",
          });
        }
        if (judgment.status !== "unknown" && judgment.evidenceIds.length === 0) {
          ctx.addIssue({
            code: "custom",
            path: ["product", "acceptance", index, "evidenceIds"],
            message: "passed and failed criterion judgments require concrete evidence",
          });
        }
        if (new Set(judgment.evidenceIds).size !== judgment.evidenceIds.length) {
          ctx.addIssue({
            code: "custom",
            path: ["product", "acceptance", index, "evidenceIds"],
            message: "a judgment cannot cite the same evidence more than once",
          });
        }
      }
      for (const criterionId of expectedCriterionIds) {
        if ((judgments.get(criterionId) ?? 0) !== 1) {
          ctx.addIssue({
            code: "custom",
            path: ["product", "acceptance"],
            message: `criterion ${criterionId} must be judged exactly once`,
          });
        }
      }
      for (const [criterionId, count] of judgments) {
        if (count > 1) {
          ctx.addIssue({
            code: "custom",
            path: ["product", "acceptance"],
            message: `criterion ${criterionId} is judged more than once`,
          });
        }
      }

      const evidenceIds = new Set<string>();
      for (const [index, evidence] of row.product.evidence.entries()) {
        if (evidenceIds.has(evidence.id)) {
          ctx.addIssue({
            code: "custom",
            path: ["product", "evidence", index, "id"],
            message: "evidence ids must be unique",
          });
        }
        evidenceIds.add(evidence.id);
      }
      const artifactIds = new Set<string>();
      for (const [index, artifact] of row.product.artifacts.entries()) {
        if (artifactIds.has(artifact.id) || evidenceIds.has(artifact.id)) {
          ctx.addIssue({
            code: "custom",
            path: ["product", "artifacts", index, "id"],
            message: "artifact ids must be globally unique within the product",
          });
        }
        artifactIds.add(artifact.id);
      }
      const proofIds = new Set([...evidenceIds, ...artifactIds]);
      for (const [judgmentIndex, judgment] of row.product.acceptance.entries()) {
        for (const [evidenceIndex, evidenceId] of judgment.evidenceIds.entries()) {
          if (!proofIds.has(evidenceId)) {
            ctx.addIssue({
              code: "custom",
              path: ["product", "acceptance", judgmentIndex, "evidenceIds", evidenceIndex],
              message: `unknown evidence or artifact id ${evidenceId}`,
            });
          }
        }
      }
      if (row.outputContract === "evidence_collection" && row.product.evidence.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["product", "evidence"],
          message: "evidence_collection requires at least one evidence item",
        });
      }
      if (row.outputContract === "artifact_collection" && row.product.artifacts.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["product", "artifacts"],
          message: "artifact_collection requires at least one artifact",
        });
      }
      if (row.outputContract === "goal_contract" && row.product.work === "refine_goal" && !row.product.details.goal) {
        ctx.addIssue({
          code: "custom",
          path: ["product", "details", "goal"],
          message: "goal_contract requires a complete structured goal",
        });
      }
      if (
        row.outputContract === "classification" &&
        row.product.work === "research" &&
        !row.product.details.classification
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["product", "details", "classification"],
          message: "classification requires a structured label and rationale",
        });
      }
      if (
        row.outputContract === "condition" &&
        (row.product.work === "research" || row.product.work === "poc") &&
        !row.product.details.condition
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["product", "details", "condition"],
          message: "condition requires a machine-readable state and rationale",
        });
      }
      if (
        row.outputContract === "issue_scan" &&
        row.product.work === "research" &&
        row.product.details.issues === undefined
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["product", "details", "issues"],
          message: "research issue_scan requires an explicit issues list, which may be empty",
        });
      }
      if (
        row.product.work === "review" &&
        row.product.details.verdict !== "pass" &&
        row.product.details.findings.length === 0
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["product", "details", "findings"],
          message: "a fail or mixed review verdict requires at least one finding",
        });
      }
      if (
        row.product.work === "poc" &&
        row.product.details.result === "supported" &&
        row.product.evidence.length === 0
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["product", "evidence"],
          message: "a supported POC hypothesis requires observed evidence",
        });
      }
    }
    if (row.blockage && row.blockage.work !== row.work) {
      ctx.addIssue({ code: "custom", path: ["blockage", "work"], message: "blockage work must match outcome work" });
    }
    if (row.blockage) {
      const ids = new Set<string>();
      for (const [index, evidence] of row.blockage.evidence.entries()) {
        if (ids.has(evidence.id)) {
          ctx.addIssue({
            code: "custom",
            path: ["blockage", "evidence", index, "id"],
            message: "blocked-work evidence ids must be unique",
          });
        }
        ids.add(evidence.id);
      }
    }
  });

export const dv2FinalSchema = z
  .strictObject({
    status: z.enum(["complete", "blocked", "runtime_failed", "fuel_exhausted"]),
    summary: textSchema,
    outcome: dv2OutcomeSchema,
  })
  .superRefine((row, ctx) => {
    const budgetExhausted =
      row.outcome.status === "runtime_failed" && row.outcome.runtimeFailure?.code === "budget_exhausted";
    if (row.status === "fuel_exhausted" && !budgetExhausted) {
      ctx.addIssue({
        code: "custom",
        path: ["status"],
        message: "fuel_exhausted requires a nested budget_exhausted runtime failure",
      });
    } else if (row.status !== "fuel_exhausted" && budgetExhausted) {
      ctx.addIssue({
        code: "custom",
        path: ["status"],
        message: "a nested budget_exhausted runtime failure requires fuel_exhausted",
      });
    } else if (row.status !== "fuel_exhausted" && row.status !== row.outcome.status) {
      ctx.addIssue({ code: "custom", path: ["outcome", "status"], message: "final status must match outcome status" });
    }
  });

/** Registered output tables for the experimental runtime. */
export const delegationV2Schemas = {
  dv2Author: authorEnvelopeSchema,
  dv2Worker: workerEnvelopeSchema,
  dv2Validation: dv2ValidationSchema,
  dv2Outcome: dv2OutcomeSchema,
  dv2Final: dv2FinalSchema,
  dv2Question: dv2QuestionSchema,
  dv2Answer: dv2AnswerSchema,
} as const;
