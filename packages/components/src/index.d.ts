import * as _smthrs_driver_workflow_types from '@smthrs/driver/workflow-types';
import * as _smthrs_driver_WorkflowDriverOptions from '@smthrs/driver/WorkflowDriverOptions';
import * as _smthrs_driver_WorkflowDefinition from '@smthrs/driver/WorkflowDefinition';
import { WorkflowDefinition } from '@smthrs/driver/WorkflowDefinition';
import * as _smthrs_errors_SmithersErrorCode from '@smthrs/errors/SmithersErrorCode';
import { SmithersErrorCode as SmithersErrorCode$1 } from '@smthrs/errors/SmithersErrorCode';
import * as _smthrs_scheduler_SmithersWorkflowOptions from '@smthrs/scheduler/SmithersWorkflowOptions';
import * as _smthrs_db_SchemaRegistryEntry from '@smthrs/db/SchemaRegistryEntry';
import * as _smthrs_driver from '@smthrs/driver';
import { SmithersCtx as SmithersCtx$1 } from '@smthrs/driver';
import * as _smthrs_driver_RunAuthContext from '@smthrs/driver/RunAuthContext';
import * as _smthrs_scheduler_RetryPolicy from '@smthrs/scheduler/RetryPolicy';
import { RetryPolicy as RetryPolicy$1 } from '@smthrs/scheduler/RetryPolicy';
import * as _smthrs_driver_OutputKey from '@smthrs/driver/OutputKey';
import * as _smthrs_driver_OutputAccessor from '@smthrs/driver/OutputAccessor';
import { InferOutputEntry as InferOutputEntry$1 } from '@smthrs/driver/OutputAccessor';
import * as _smthrs_graph from '@smthrs/graph';
import * as _smthrs_scheduler from '@smthrs/scheduler';
import * as _smthrs_scheduler_CachePolicy from '@smthrs/scheduler/CachePolicy';
import { CachePolicy as CachePolicy$1 } from '@smthrs/scheduler/CachePolicy';
import * as React$1 from 'react';
import React__default from 'react';
import * as zod from 'zod';
import { z } from 'zod';
import * as _smthrs_agents_AgentLike from '@smthrs/agents/AgentLike';
import { AgentLike as AgentLike$2 } from '@smthrs/agents/AgentLike';
import { SmithersError } from '@smthrs/errors/SmithersError';
import * as _smthrs_graph_types from '@smthrs/graph/types';
import { ScorersMap as ScorersMap$1 } from '@smthrs/graph/types';
import { ProofBinding } from '@smthrs/graph/ProofBinding';
import { TaskMemoryConfig } from '@smthrs/memory/types';
import * as _smthrs_errors from '@smthrs/errors';
import * as zod_v4_core from 'zod/v4/core';

type WorktreeProps$2 = {
    key?: string;
    id?: string;
    path: string;
    branch?: string;
    /** Base branch for syncing worktrees (default: "main"). */
    baseBranch?: string;
    skipIf?: boolean;
    children?: React__default.ReactNode;
};

type WorkflowProps$2 = {
    name: string;
    cache?: boolean;
    children?: React__default.ReactNode;
};

/**
 * Reference to a workflow module file produced at runtime (for example by an
 * architect agent that authors a workflow mid-run). The file must default
 * export a workflow built with `smithers(...)` and must live inside the
 * approved root — paths that resolve (including through symlinks) outside the
 * root are rejected before anything is imported.
 */
type WorkflowFileRef$1 = {
    /**
     * Path to the workflow module. Relative paths resolve against the approved
     * root.
     */
    path: string;
    /**
     * Directory the workflow file must stay within. Defaults to the parent
     * run's `rootDir`.
     */
    approvedRoot?: string;
};

/** Valid output targets: a Zod schema (recommended), a Drizzle table object, or a string key (escape hatch). */
type OutputTarget$1 = z.ZodObject<z.ZodRawShape> | {
    $inferSelect: Record<string, unknown>;
} | string;

type WaitForEventProps$2 = {
    id: string;
    /** Event name/type to wait for. */
    event: string;
    /** Correlation key to match the right event instance. */
    correlationId?: string;
    /** Where to store the event payload. */
    output: OutputTarget$1;
    /** Zod schema for the event payload. */
    outputSchema?: z.ZodObject<z.ZodRawShape>;
    /** Max wait time in ms before timing out. */
    timeoutMs?: number;
    /** Behavior on timeout: fail (default), skip the node, or continue with a tagged timeout result. */
    onTimeout?: "fail" | "skip" | "continue";
    /** Opt into the tagged `{ kind, payload }` wait-result envelope. */
    tagged?: boolean;
    /** Do not block unrelated downstream flow while waiting for the event. */
    async?: boolean;
    skipIf?: boolean;
    /** Explicit dependency on other task node IDs. */
    dependsOn?: string[];
    /** Named dependencies on other tasks. Keys become context keys, values are task node IDs. */
    needs?: Record<string, string>;
    label?: string;
    meta?: Record<string, unknown>;
    key?: string;
};

type WorkflowViewBootProps$1 = Record<string, unknown>;
type WorkflowViewProps$1 = {
    /**
     * Browser/TUI entry module to render for this workflow. Relative paths are
     * resolved from the workflow source file when the gateway registered it with
     * `entryFile`.
     */
    entry?: string;
    /**
     * Browser-safe module containing a React component export. This is for
     * advanced clients; importing the workflow module itself is usually wrong
     * because workflow modules can open DBs and import Node/Bun-only code.
     */
    source?: string;
    /** Export name from `source`. Defaults to `default` only when `source` is set. */
    exportName?: string;
    /** URL path for `<UI>`; ignored by `<TUI>`. Defaults to `/workflows/<key>`. */
    path?: string;
    title?: string;
    /** JSON-serializable boot props passed to the client React app. */
    props?: WorkflowViewBootProps$1;
    /**
     * Literal intrinsic React elements for the POC inline path. Function
     * components and event handlers are intentionally rejected by the gateway
     * serializer; use `entry`/`source` for interactive apps.
     */
    children?: React__default.ReactNode;
};
type UIProps$1 = WorkflowViewProps$1;
type TUIProps$1 = Omit<WorkflowViewProps$1, "path">;

declare const roleSchema: z.ZodEnum<{
    fable: "fable";
    sol: "sol";
    terra: "terra";
    luna: "luna";
}>;
type DelegationV2Role = z.infer<typeof roleSchema>;
declare const workKindSchema: z.ZodEnum<{
    synthesize: "synthesize";
    plan: "plan";
    review: "review";
    preview: "preview";
    poc: "poc";
    research: "research";
    refine_goal: "refine_goal";
    execute: "execute";
}>;
type DelegationV2WorkKind = z.infer<typeof workKindSchema>;
declare const outputContractIdSchema: z.ZodEnum<{
    plan: "plan";
    goal_contract: "goal_contract";
    work_product: "work_product";
    evidence_collection: "evidence_collection";
    issue_scan: "issue_scan";
    classification: "classification";
    condition: "condition";
    evaluation: "evaluation";
    artifact_collection: "artifact_collection";
}>;
type OutputContractId = z.infer<typeof outputContractIdSchema>;
declare const goalContractSchema: z.ZodObject<{
    objective: z.ZodString;
    context: z.ZodArray<z.ZodString>;
    constraints: z.ZodArray<z.ZodString>;
    nonGoals: z.ZodArray<z.ZodString>;
}, z.core.$strict>;
type GoalContract = z.infer<typeof goalContractSchema>;
declare const acceptanceCriterionSchema: z.ZodObject<{
    id: z.ZodString;
    requirement: z.ZodString;
    verification: z.ZodString;
}, z.core.$strict>;
type AcceptanceCriterion = z.infer<typeof acceptanceCriterionSchema>;
declare const inputRefSchema: z.ZodObject<{
    from: z.ZodString;
    contract: z.ZodEnum<{
        plan: "plan";
        goal_contract: "goal_contract";
        work_product: "work_product";
        evidence_collection: "evidence_collection";
        issue_scan: "issue_scan";
        classification: "classification";
        condition: "condition";
        evaluation: "evaluation";
        artifact_collection: "artifact_collection";
    }>;
    purpose: z.ZodString;
}, z.core.$strict>;
type InputRef = z.infer<typeof inputRefSchema>;
declare const promptSpecSchema: z.ZodObject<{
    instructions: z.ZodString;
    contextRefs: z.ZodArray<z.ZodString>;
}, z.core.$strict>;
type PromptSpec = z.infer<typeof promptSpecSchema>;
declare const criticalExecutionCategorySchema: z.ZodEnum<{
    security_boundary: "security_boundary";
    data_integrity: "data_integrity";
    concurrency_invariant: "concurrency_invariant";
    protocol_core: "protocol_core";
    irreversible_migration: "irreversible_migration";
}>;
type CriticalExecutionCategory = z.infer<typeof criticalExecutionCategorySchema>;
/** Model request; trusted caller policy must separately admit every bound. */
declare const criticalitySchema: z.ZodObject<{
    category: z.ZodEnum<{
        security_boundary: "security_boundary";
        data_integrity: "data_integrity";
        concurrency_invariant: "concurrency_invariant";
        protocol_core: "protocol_core";
        irreversible_migration: "irreversible_migration";
    }>;
    invariant: z.ZodString;
    whyHighTierIsRequired: z.ZodString;
    whyTheCoreCannotBeDelegated: z.ZodString;
    allowedPaths: z.ZodArray<z.ZodString>;
    expectedChangedLines: z.ZodNumber;
    lineSensitivity: z.ZodString;
    surroundingWorkDelegatedTo: z.ZodArray<z.ZodString>;
    reviewNodeId: z.ZodString;
}, z.core.$strict>;
type Criticality = z.infer<typeof criticalitySchema>;
type WorkflowAgentExpr = {
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
type WorkflowSequenceExpr = {
    tag: "sequence";
    id: string;
    steps: WorkflowExpr[];
};
type WorkflowParallelExpr = {
    tag: "parallel";
    id: string;
    branches: WorkflowExpr[];
    maxConcurrency?: number;
};
type WorkflowExpr = WorkflowAgentExpr | WorkflowSequenceExpr | WorkflowParallelExpr;
declare const workflowProgramSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    registryVersion: z.ZodString;
    id: z.ZodString;
    objective: z.ZodObject<{
        objective: z.ZodString;
        context: z.ZodArray<z.ZodString>;
        constraints: z.ZodArray<z.ZodString>;
        nonGoals: z.ZodArray<z.ZodString>;
    }, z.core.$strict>;
    rationale: z.ZodString;
    root: z.ZodType<WorkflowExpr, unknown, z.core.$ZodTypeInternals<WorkflowExpr, unknown>>;
    outputs: z.ZodArray<z.ZodObject<{
        from: z.ZodString;
        contract: z.ZodEnum<{
            plan: "plan";
            goal_contract: "goal_contract";
            work_product: "work_product";
            evidence_collection: "evidence_collection";
            issue_scan: "issue_scan";
            classification: "classification";
            condition: "condition";
            evaluation: "evaluation";
            artifact_collection: "artifact_collection";
        }>;
    }, z.core.$strict>>;
    supersedes: z.ZodOptional<z.ZodObject<{
        id: z.ZodString;
        digest: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>;
type WorkflowProgram = z.infer<typeof workflowProgramSchema>;

type TrellisAgents = Record<DelegationV2Role, AgentLike$2 | AgentLike$2[]>;
type TrellisOutputs = {
    dv2Author: OutputTarget$1;
    dv2Worker: OutputTarget$1;
    dv2Validation: OutputTarget$1;
    dv2Outcome: OutputTarget$1;
    dv2Final: OutputTarget$1;
    dv2Question: OutputTarget$1;
    dv2Answer: OutputTarget$1;
};
type TrellisLimits = {
    /** Hard global cap partitioned across every Sol/Fable turn and semantic repair in the recursive tree. */
    maxTotalAuthorTurns?: number;
    /** Maximum author continuations for one logical invocation, including generation zero. */
    maxAuthorGenerations?: number;
    /** Maximum recursively nested Sol/Fable author invocations. */
    maxAuthorDepth?: number;
    /** Maximum nodes accepted in one authored fragment. */
    maxNodesPerProgram?: number;
    /** Maximum expression depth inside one authored fragment. */
    maxProgramDepth?: number;
    /** Maximum branches in one parallel expression. Sequences remain bounded by maxNodesPerProgram. */
    maxFanout?: number;
    /** Maximum bytes in one authored prompt field. */
    maxPromptBytes?: number;
    /** Maximum aggregate authored prompt bytes in one fragment. */
    maxTotalPromptBytes?: number;
};
type TrellisCriticalExecutionCategory = CriticalExecutionCategory;
/**
 * Trusted caller-owned ceiling for exceptional Sol/Fable implementation.
 * Omitting it disables direct high-tier execution. Authored requests must fit
 * every category, workspace-relative path, and changed-line bound below.
 */
type TrellisCriticalExecutionPolicy = {
    allowedCategories: TrellisCriticalExecutionCategory[];
    allowedPathPrefixes: string[];
    maxChangedLines: number;
};
type TrellisProps$2 = {
    /** Human goal. A root GoalContract is derived from this when goal is omitted. */
    prompt: string;
    /** Optional explicit root goal contract. */
    goal?: GoalContract;
    /** Root proof obligations exposed to every author continuation. */
    acceptance?: AcceptanceCriterion[];
    /** Extra trusted caller instructions; never interpreted as graph authority. */
    instructions?: string;
    /** Root author role. Terra and Luna are intentionally rejected here. */
    role?: Extract<DelegationV2Role, "sol" | "fable">;
    /** Root work playbook. */
    work?: DelegationV2WorkKind;
    /** Nominal contract returned by the root invocation. Default: work_product. */
    outputContract?: OutputContractId;
    /** Role-bound agents or failover chains. */
    agents: TrellisAgents;
    /** Output targets registered from delegationV2Schemas. */
    outputs: TrellisOutputs;
    /** Gateway-safe namespace for every physical node id. Default: trellis. */
    idPrefix?: string;
    /** Caller-owned revision for provider/tool policy changes not otherwise visible in agent metadata. */
    semanticRevision?: string;
    /** Caller-owned exceptional implementation ceiling. Omit to force all executable work below Sol/Fable. */
    criticalExecutionPolicy?: TrellisCriticalExecutionPolicy;
    /** Local and compiler cap for every Parallel. The run must pin the same cap. */
    maxConcurrency?: number;
    limits?: TrellisLimits;
    skipIf?: boolean;
};

type TryCatchFinallyProps$2 = {
    id?: string;
    try: React__default.ReactElement;
    catch?: React__default.ReactElement | ((error: SmithersError) => React__default.ReactElement);
    catchErrors?: SmithersErrorCode$1[];
    finally?: React__default.ReactElement;
    skipIf?: boolean;
};

type TimerProps$2 = {
    id: string;
    /**
     * Relative duration (examples: "500ms", "1s", "30m", "1h", "7d").
     */
    duration?: string;
    /**
     * Absolute fire time (ISO timestamp or Date).
     */
    until?: string | Date;
    /**
     * Recurring timer syntax is reserved for phase 2 and is not supported yet.
     */
    every?: string;
    skipIf?: boolean;
    dependsOn?: string[];
    needs?: Record<string, string>;
    label?: string;
    meta?: Record<string, unknown>;
    key?: string;
};

type DepsSpec$1 = Record<string, OutputTarget$1>;

type InferDepValue<T> = T extends string ? unknown : InferOutputEntry$1<T>;
type InferDeps$1<D extends DepsSpec$1> = {
    [K in keyof D]: InferDepValue<D[K]>;
};

type TaskProps$2<Row, Output extends OutputTarget$1 = OutputTarget$1, D extends DepsSpec$1 = {}> = {
    key?: string;
    id: string;
    /** Where to store the task's result. Pass a Zod schema from `outputs` (recommended), a Drizzle table, or a string key. */
    output: Output;
    /**
     * Optional Zod schema describing the expected agent output shape.
     * When `output` is already a ZodObject this is inferred automatically.
     * Used for validation and to inject schema examples into MDX prompts.
     */
    outputSchema?: z.ZodObject<z.ZodRawShape>;
    /** Maximum automatic output-format/schema correction calls after the initial agent call. Set to 0 to disable corrections. Default: 3. */
    maxSchemaRetries?: number;
    /** Agent or array of agents [primary, fallback1, fallback2, ...]. Tries in order on retries. */
    agent?: AgentLike$2 | AgentLike$2[];
    /** Convenience alias for a single retry fallback without exposing array syntax in JSX. */
    fallbackAgent?: AgentLike$2;
    /** Explicit dependency on other task node IDs. The task will not run until all listed tasks complete. */
    dependsOn?: string[];
    /** Named dependencies on other tasks. Keys become context keys, values are task node IDs. */
    needs?: Record<string, string>;
    /** Render-time typed dependencies. Keys resolve from task ids of the same name, or from matching `needs` entries. */
    deps?: D;
    /**
     * When true, `deps` resolution omits keys whose upstream task has no output
     * (e.g. a `continueOnFail` task that failed) instead of deferring the task
     * until every dep resolves. Pair with `needs`/`dependsOn` so the task is
     * still gated on upstream tasks reaching a terminal state.
     *
     * Runtime caveat: under `depsOptional`, a resolved `deps` value is absent
     * (not present-but-undefined) when its upstream produced no output, even
     * though the `children(deps)` callback types every key as present. Null-check
     * each dep you read (`deps.a?.field`) — reading `deps.a.field` for a failed
     * upstream throws at runtime despite compiling cleanly.
     */
    depsOptional?: boolean;
    /**
     * Start this agent task from a copy of another task's final agent session context.
     * The fork source becomes an implicit dependency: this task waits for it to complete,
     * then copies its conversation snapshot into a fresh, independent session and submits
     * its own prompt. The source is never mutated. Inside a `<Loop>`, resolves to the
     * latest completed snapshot for that task id. Requires an agent task.
     */
    fork?: string;
    /** Schedule only while every bound authority row still has the proved content digest. */
    bind?: ProofBinding | ProofBinding[];
    skipIf?: boolean;
    needsApproval?: boolean;
    /** When paired with `needsApproval`, do not block unrelated downstream flow while the approval is pending. */
    async?: boolean;
    timeoutMs?: number;
    heartbeatTimeoutMs?: number;
    heartbeatTimeout?: number;
    /** Disable retries entirely. Equivalent to retries={0}. */
    noRetry?: boolean;
    retries?: number;
    retryPolicy?: RetryPolicy$1;
    continueOnFail?: boolean;
    cache?: CachePolicy$1;
    /** Optional scorers to evaluate this task's output after completion. */
    scorers?: ScorersMap$1;
    /** Expected output supplied to scorers that compare against a reference answer. */
    groundTruth?: unknown;
    /** Additional source context supplied to scorers such as faithfulnessScorer. */
    context?: unknown;
    /** Optional cross-run memory configuration. */
    memory?: TaskMemoryConfig;
    /** Request an immediate hijack handoff as soon as the task starts running. */
    hijack?: boolean;
    /** What Smithers should do after a hijacked session exits. */
    onHijackExit?: "complete" | "reopen";
    allowTools?: string[];
    /**
     * Mark each attempt as an external side effect. `true` is non-idempotent;
     * the object form can declare idempotency and an idempotent compensation.
     */
    sideEffect?: boolean | {
        idempotent?: boolean;
        revert?: (ctx: {
            outputRow: unknown | null;
            effectStatus: "succeeded" | "unknown";
            runId: string;
            nodeId: string;
            iteration: number;
            attempt: number;
        }) => Promise<void>;
    };
    /**
     * Scheduling priority (default 0, or the nearest `<Parallel>`/`<MergeQueue>`
     * ancestor's priority). When more tasks are runnable than free concurrency
     * slots, higher priority claims slots first; ties keep plan order. Never
     * overrides dependencies or group caps.
     */
    priority?: number;
    /** Override the nearest container failure policy for this task. */
    failurePolicy?: "halt" | "quarantine";
    label?: string;
    meta?: Record<string, unknown>;
    /** @internal Used by createSmithers() to bind tasks to the correct workflow context. */
    smithersContext?: React__default.Context<SmithersCtx$1<unknown> | null>;
    children?: string | Row | (() => Row | Promise<Row>) | React__default.ReactNode | ((deps: InferDeps$1<D>) => Row | Promise<Row> | React__default.ReactNode);
};

type SupervisorProps$2 = {
    id?: string;
    /** Agent that plans, delegates, and reviews worker results. */
    boss: AgentLike$2;
    /** Map of worker type names to agents (e.g., { coder, tester, docs }). */
    workers: Record<string, AgentLike$2>;
    /** Output schema for the boss's plan. Must include `tasks: Array<{ id, workerType, instructions }>`. */
    planOutput: OutputTarget$1;
    /** Output schema for individual worker results. */
    workerOutput: OutputTarget$1;
    /** Output schema for the boss's review. Must include `allDone: boolean` and `retriable: string[]`. */
    reviewOutput: OutputTarget$1;
    /** Output schema for the final summary. */
    finalOutput: OutputTarget$1;
    /** Max delegate-review cycles (default 3). */
    maxIterations?: number;
    /** Max parallel workers (default 5). */
    maxConcurrency?: number;
    /** Whether each worker gets its own git worktree (default false). */
    useWorktrees?: boolean;
    skipIf?: boolean;
    /** Goal/prompt for the boss agent. */
    children: string | React__default.ReactNode;
};

type SuperSmithersProps$2 = {
    /** Optional ID prefix for all generated task IDs. */
    id?: string;
    /** Markdown string or MDX component describing the intervention strategy. */
    strategy: string | React__default.ReactElement;
    /** Agent that reads code and decides modifications. */
    agent: AgentLike$2;
    /** Glob patterns of files the agent can modify. */
    targetFiles?: string[];
    /** Output schema for the intervention report (Zod object). */
    reportOutput?: OutputTarget$1;
    /** If true, reports changes without applying them. */
    dryRun?: boolean;
    /** Standard skip predicate. */
    skipIf?: boolean;
};

type SubflowProps$2 = {
    id: string;
    /**
     * The child workflow definition: a built workflow object, or a
     * `{ path, approvedRoot? }` reference to a workflow module file generated
     * at runtime (loaded from the approved root when the node executes).
     */
    workflow: WorkflowDefinition<unknown> | WorkflowFileRef$1;
    /** Input to pass to the child workflow. */
    input?: unknown;
    /** `"childRun"` gets its own DB row/run; `"inline"` embeds in parent. */
    mode?: "childRun" | "inline";
    /**
     * Where to store the subflow's result in the parent.
     *
     * In `"childRun"` mode the persisted value is the child's normalized
     * `RunResult.output`: the row the child's last task wrote to the child's
     * declared result schema (`smithers(build, { output })`, defaulting to the
     * schema key literally named `output`), with the system columns (`runId`,
     * `nodeId`, `iteration`) stripped. It is not a table-keyed snapshot of the
     * child's output tables. Zero result rows normalize to `null`; exactly one
     * row unwraps to that plain row object; multiple rows (several writers or
     * loop iterations) persist as an array of rows. The value is validated
     * against this target's schema like any task output, so adding or changing
     * the child's final task changes the shape the parent must expect here.
     */
    output: OutputTarget$1;
    skipIf?: boolean;
    timeoutMs?: number;
    heartbeatTimeoutMs?: number;
    heartbeatTimeout?: number;
    retries?: number;
    retryPolicy?: RetryPolicy$1;
    continueOnFail?: boolean;
    cache?: CachePolicy$1;
    /** Explicit dependency on other task node IDs. */
    dependsOn?: string[];
    /** Named dependencies on other tasks. Keys become context keys, values are task node IDs. */
    needs?: Record<string, string>;
    label?: string;
    meta?: Record<string, unknown>;
    key?: string;
    children?: React__default.ReactNode;
};

type SourceDef$1 = {
    agent: AgentLike$2;
    /** Prompt for this source. A string or ReactNode. */
    prompt?: string;
    /** Output schema for this specific source. Overrides `gatherOutput`. */
    output?: OutputTarget$1;
    children?: React__default.ReactNode;
};

type SignalProps$2<Schema extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>> = {
    id: string;
    schema: Schema;
    correlationId?: string;
    timeoutMs?: number;
    onTimeout?: "fail" | "skip" | "continue";
    /** Do not block unrelated downstream flow while waiting for the signal. */
    async?: boolean;
    skipIf?: boolean;
    dependsOn?: string[];
    needs?: Record<string, string>;
    label?: string;
    meta?: Record<string, unknown>;
    key?: string;
    children?: (data: z.infer<Schema>) => React__default.ReactNode;
    smithersContext?: React__default.Context<SmithersCtx$1<unknown> | null>;
};

type SidecarProps$2 = {
    id?: string;
    agent: AgentLike$2 | AgentLike$2[];
    sidecar: AgentLike$2 | AgentLike$2[];
    output: OutputTarget$1;
    sidecarOutput?: OutputTarget$1;
    scorers?: ScorersMap$1;
    prompt?: string | React__default.ReactNode;
    input?: string | React__default.ReactNode;
    maxConcurrency?: number;
    groundTruth?: unknown;
    context?: unknown;
    primaryLabel?: string;
    sidecarLabel?: string;
    skipIf?: boolean;
    children?: string | React__default.ReactNode;
};

type SidecarDelta$2 = {
    primaryScore: number | null;
    sidecarScore: number | null;
    delta: number | null;
    cheaperWins: boolean;
};

type SequenceProps$2 = {
    key?: string;
    /** Display name for this group in run views (graph, /workflows mirror). */
    label?: string;
    failurePolicy?: "halt" | "quarantine";
    skipIf?: boolean;
    children?: React__default.ReactNode;
};

type ScanFixVerifyProps$2 = {
    /** ID prefix for generated task/component ids. */
    id?: string;
    /** Agent that scans for problems. */
    scanner: AgentLike$2;
    /** Agent (or agents) that fixes problems. When an array is provided, agents are cycled across issues. */
    fixer: AgentLike$2 | AgentLike$2[];
    /** Agent that verifies the fixes were applied correctly. */
    verifier: AgentLike$2;
    /** Output schema for scan results. Should include `issues: Array`. */
    scanOutput: OutputTarget$1;
    /** Output schema for each individual fix. */
    fixOutput: OutputTarget$1;
    /** Output schema for verification results. */
    verifyOutput: OutputTarget$1;
    /** Output schema for the final summary report. */
    reportOutput: OutputTarget$1;
    /** Maximum number of parallel fix tasks. */
    maxConcurrency?: number;
    /** Maximum scan-fix-verify cycles before stopping. Default 3. */
    maxRetries?: number;
    /** Skip the entire component. */
    skipIf?: boolean;
    /** Prompt/context describing what to scan for. */
    children?: React__default.ReactNode;
};

type SandboxWorkspaceSpec$1 = {
    name: string;
    snapshotId?: string;
    idleTimeoutSecs?: number;
    persistence?: "ephemeral" | "sticky";
};

type SandboxVolumeMount$1 = {
    host: string;
    container: string;
    readonly?: boolean;
};

type SandboxRuntime$1 = "bubblewrap" | "docker" | "codeplane" | "cloudflare";

type SandboxEgressConfig$1 = {
    env?: Record<string, string>;
    httpProxy?: string;
    httpsProxy?: string;
    noProxy?: string | string[];
    caCertPem?: string;
    caCertPath?: string;
    secretBindings?: Record<string, string>;
};

type SandboxProps$2 = {
    id: string;
    /** Child workflow definition. If omitted, createSmithers-bound Sandbox wrappers may provide one. */
    workflow?: WorkflowDefinition<unknown>;
    /** Input passed to the child workflow. */
    input?: unknown;
    output: OutputTarget$1;
    /** Injectable sandbox provider object or a provider id registered with the sandbox package. */
    provider?: unknown;
    /** @deprecated Prefer provider. Kept for legacy local transports. */
    runtime?: SandboxRuntime$1;
    allowNetwork?: boolean;
    reviewDiffs?: boolean;
    autoAcceptDiffs?: boolean;
    /** Allow this sandbox to execute while already inside another sandbox. Disabled by default. */
    allowNested?: boolean;
    image?: string;
    env?: Record<string, string>;
    egress?: SandboxEgressConfig$1;
    ports?: Array<{
        host: number;
        container: number;
    }>;
    volumes?: SandboxVolumeMount$1[];
    memoryLimit?: string;
    cpuLimit?: string;
    command?: string;
    workspace?: SandboxWorkspaceSpec$1;
    skipIf?: boolean;
    timeoutMs?: number;
    heartbeatTimeoutMs?: number;
    heartbeatTimeout?: number;
    retries?: number;
    retryPolicy?: RetryPolicy$1;
    continueOnFail?: boolean;
    cache?: CachePolicy$1;
    dependsOn?: string[];
    needs?: Record<string, string>;
    label?: string;
    meta?: Record<string, unknown>;
    key?: string;
    children?: React__default.ReactNode;
};

type SagaStepProps$2 = {
    id: string;
    compensation: React__default.ReactElement;
    children: React__default.ReactElement;
};

type SagaStepDef$1 = {
    id: string;
    action: React__default.ReactElement;
    compensation: React__default.ReactElement;
    label?: string;
};

type SagaProps$2 = {
    id?: string;
    steps?: SagaStepDef$1[];
    onFailure?: "compensate" | "compensate-and-fail" | "fail";
    skipIf?: boolean;
    children?: React__default.ReactNode;
};

type RunbookStep$1 = {
    /** Unique step identifier. */
    id: string;
    /** Agent for this step (falls back to `defaultAgent`). */
    agent?: AgentLike$2;
    /** Shell command or instruction for the step. */
    command?: string;
    /** Risk classification: safe auto-executes, risky/critical require approval. */
    risk: "safe" | "risky" | "critical";
    /** Human-readable label for the step. */
    label?: string;
    /** Per-step output schema override. */
    output?: OutputTarget$1;
};

type ApprovalRequest$1 = {
    title: string;
    summary?: string;
    metadata?: Record<string, unknown>;
};

type RunbookProps$2 = {
    id?: string;
    /** Ordered steps to execute. */
    steps: RunbookStep$1[];
    /** Default agent for steps that don't specify one. */
    defaultAgent?: AgentLike$2;
    /** Default output schema for step results. */
    stepOutput: OutputTarget$1;
    /** Template for approval requests on risky/critical steps. */
    approvalRequest?: Partial<ApprovalRequest$1>;
    /** Behavior when a risky/critical step is denied: "fail" (default) or "skip". */
    onDeny?: "fail" | "skip";
    skipIf?: boolean;
};

type ReviewLoopProps$2 = {
    id?: string;
    /** Agent that produces or fixes the work each iteration. */
    producer: AgentLike$2;
    /** Agent (or agents) that reviews the produced work. */
    reviewer: AgentLike$2 | AgentLike$2[];
    /** Output schema for the produced work. */
    produceOutput: OutputTarget$1;
    /** Output schema for the review result. Must include an `approved: boolean` field. */
    reviewOutput: OutputTarget$1;
    /** Maximum number of review cycles before stopping. @default 5 */
    maxIterations?: number;
    /** Behavior when maxIterations is reached. @default "return-last" */
    onMaxReached?: "return-last" | "fail";
    /** Skip the entire review loop. */
    skipIf?: boolean;
    /** Initial prompt for the producer (string or ReactNode). */
    children: string | React__default.ReactNode;
};

type LoopProps$2 = {
    key?: string;
    id?: string;
    until?: boolean;
    maxIterations?: number;
    onMaxReached?: "fail" | "return-last";
    continueAsNewEvery?: number;
    skipIf?: boolean;
    children?: React__default.ReactNode;
};

/** @deprecated Use `LoopProps` instead. */
type RalphProps$1 = LoopProps$2;

type PollerProps$2 = {
    /** ID prefix for generated task/component ids. */
    id?: string;
    /** Agent or compute function that checks the condition. */
    check: AgentLike$2 | (() => unknown | Promise<unknown>);
    /** Output schema for the check result. Must include `satisfied: boolean`. */
    checkOutput: OutputTarget$1;
    /** Maximum poll attempts. Default 30. */
    maxAttempts?: number;
    /** Strategy used to scale the inter-attempt delay. Default "fixed". */
    backoff?: "fixed" | "linear" | "exponential";
    /**
     * Base delay in milliseconds BETWEEN poll attempts; the first attempt runs
     * immediately. Enforced by a durable `<Timer>`. Default 5000.
     */
    intervalMs?: number;
    /** Timeout in ms for a single check attempt. Unbounded when unset. */
    checkTimeoutMs?: number;
    /** Behavior when maxAttempts is reached. Default "fail". */
    onTimeout?: "fail" | "return-last";
    /** Skip the entire component. */
    skipIf?: boolean;
    /** Prompt/condition description for the check agent. */
    children?: React__default.ReactNode;
};

type ParallelProps$2 = {
    id?: string;
    /** Display name for this group in run views (graph, /workflows mirror). */
    label?: string;
    maxConcurrency?: number;
    /**
     * Opt-in subtree cap (int >= 1): at most this many DIRECT CHILDREN (whole
     * subtrees, e.g. tickets) in flight at once. Unlike `maxConcurrency`, which
     * caps leaf tasks whose innermost group is this parallel, it covers every
     * descendant task. Both props may coexist.
     */
    subtreeConcurrency?: number;
    /**
     * Scheduling priority inherited by descendant task nodes as their default
     * (default 0; an explicit `priority` on a child wins). When more tasks are
     * runnable than free concurrency slots, higher priority claims slots
     * first; ties keep plan order. Never overrides dependencies or caps.
     */
    priority?: number;
    failurePolicy?: "halt" | "quarantine";
    skipIf?: boolean;
    children?: React__default.ReactNode;
};

type PanelistConfig$1 = {
    /** A single agent, or a failover CHAIN (`AgentLike[]`) run as one panelist. */
    agent: AgentLike$2 | AgentLike$2[];
    role?: string;
    label?: string;
};

/** Extra Task props applied to a panel's generated tasks (panelists or moderator). */
type PanelTaskOptions = {
    continueOnFail?: boolean;
    timeoutMs?: number;
    heartbeatTimeoutMs?: number;
    retries?: number;
};
type PanelProps$2 = {
    id?: string;
    /**
     * Panelists. Each entry is a single agent, a {@link PanelistConfig}, or a
     * failover CHAIN (`AgentLike[]`). A chain becomes one panelist whose task
     * runs it as a failover sequence.
     */
    panelists: Array<PanelistConfig$1 | AgentLike$2 | AgentLike$2[]>;
    moderator: AgentLike$2 | AgentLike$2[];
    panelistOutput: OutputTarget$1;
    moderatorOutput: OutputTarget$1;
    strategy?: "synthesize" | "vote" | "consensus";
    minAgree?: number;
    maxConcurrency?: number;
    /** Extra Task props applied to every panelist task (e.g. continueOnFail, timeouts). */
    panelistTaskProps?: PanelTaskOptions;
    /** Extra Task props applied to the moderator task. */
    moderatorTaskProps?: PanelTaskOptions;
    skipIf?: boolean;
    children: string | React__default.ReactNode;
};

type OptimizerProps$2 = {
    id?: string;
    /** Agent that generates or improves candidates each iteration. */
    generator: AgentLike$2;
    /** Agent (or compute function) that scores candidates. */
    evaluator: AgentLike$2 | ((candidate: unknown) => unknown | Promise<unknown>);
    /** Output schema for generated candidates. */
    generateOutput: OutputTarget$1;
    /** Output schema for evaluation results. Must include a `score: number` field. */
    evaluateOutput: OutputTarget$1;
    /** Score threshold to stop early. When omitted, runs all iterations. */
    targetScore?: number;
    /** Maximum optimization rounds. @default 10 */
    maxIterations?: number;
    /** Behavior when maxIterations is reached. @default "return-last" */
    onMaxReached?: "return-last" | "fail";
    /** Skip the entire optimization loop. */
    skipIf?: boolean;
    /** Initial generation prompt (string or ReactNode). */
    children: string | React__default.ReactNode;
};

/**
 * The closed set of conditions a `<Monitor>` heartbeat may classify a watched
 * run into. Deliberately small: a monitor that can name a hundred states is a
 * monitor nobody can route deterministically. Every sample resolves to exactly
 * one of these, and each one maps to exactly one handler.
 *
 * - `healthy`        — the run is progressing (or has finished cleanly). Do nothing.
 * - `stalled`        — no event for longer than the stall budget, nothing waiting on a human.
 * - `wedged-node`    — one node is burning attempts/retries without changing its error.
 * - `runaway-loop`   — a loop or token burn is growing without approaching its exit condition.
 * - `awaiting-human` — the run is parked on an approval gate or human request.
 * - `failing`        — the run (or a non-continueOnFail node) has failed terminally.
 * - `unknown`        — evidence was unreadable or contradictory. Never guess from here.
 */
type MonitorCondition$2 = "healthy" | "stalled" | "wedged-node" | "runaway-loop" | "awaiting-human" | "failing" | "unknown";

type MonitorProps$2 = {
    /** ID prefix for generated task/component ids. Default `"monitor"`. */
    id?: string;
    /** Run id this monitor watches. Usually `ctx.input.watchRunId`. */
    watchRunId: string;
    /** Workflow path used by shipped resume/retry commands. Defaults to `ctx.input.watchWorkflowPath`. */
    watchWorkflowPath?: string;
    /** Agent that samples the watched run and classifies its health. */
    agent: AgentLike$2 | AgentLike$2[];
    /**
     * Output target for the heartbeat classification. The schema must carry at
     * least `condition` (a {@link MonitorCondition}) and `runStatus`;
     * `targetNodeId`, `evidence`, and `summary` are read when present. `nodeId`,
     * `runId`, and `iteration` are reserved output columns — hence `targetNodeId`.
     */
    healthOutput: OutputTarget$1;
    /** Output target handler tasks write to. Defaults to `healthOutput`. */
    actionOutput?: OutputTarget$1;
    /** Agent the healing/reporting handlers run on. Defaults to `agent`. */
    healAgent?: AgentLike$2 | AgentLike$2[];
    /** Wall-clock delay between heartbeats, enforced by a durable `<Timer>`. Default 60000. */
    intervalMs?: number;
    /** Maximum heartbeats before the monitor stops watching. Default 120. */
    maxChecks?: number;
    /** Heartbeats with no progress before `stalled` is the expected verdict. Default 3. */
    stallBeats?: number;
    /**
     * Conditions the monitor may heal WITHOUT asking a human. Anything not listed
     * escalates instead. Default `["stalled", "wedged-node"]` — the two repairs
     * that are idempotent and reversible.
     */
    autoHeal?: MonitorCondition$2[];
    /**
     * Override the element rendered for a condition. `null` means "do nothing and
     * keep watching" for that condition; omit a key to keep the shipped default.
     */
    handlers?: Partial<Record<MonitorCondition$2, React__default.ReactElement | null>>;
    /** Extra repo-specific doctrine appended to the shipped monitoring prompt. */
    guidance?: string;
    /** Replace the shipped monitoring prompt entirely. Prefer `guidance` first. */
    prompt?: string | React__default.ReactNode;
    skipIf?: boolean;
    /** Alias for `prompt`. */
    children?: string | React__default.ReactNode;
};

type MemoryProps$2 = {
    /** One memory bank. Mutually exclusive with `banks`. */
    bank?: string;
    /** Memory banks recalled in parallel. Mutually exclusive with `bank`. */
    banks?: string[];
    /** Stable recall and retention dimensions such as branch, stream, source, and scope. */
    tags?: string[];
    /** Recall query mode. `auto` derives the query from each task prompt. Defaults to `auto`. */
    recall?: "auto" | string | false;
    /** Hindsight candidate-search budget. Defaults to `mid`. */
    budget?: "low" | "mid" | "high";
    /** Maximum tokens injected across recalled memories and primers. Defaults to 2048. */
    maxTokens?: number;
    /** Mental-model ids whose saved content is injected verbatim. */
    primers?: string[];
    /** Retain a successful task result asynchronously. Defaults to `off`. */
    retain?: "on-complete" | "off";
    /** Expose `remember` and `recall` tools to descendant task agents. Defaults to false. */
    tools?: boolean;
    /** Workflow content that inherits this memory configuration. */
    children?: React__default.ReactNode;
};

/**
 * Queue tasks so that at most `maxConcurrency` run concurrently across the group.
 * Defaults to 1, providing an easy merge queue primitive.
 */
type MergeQueueProps$2 = {
    id?: string;
    maxConcurrency?: number;
    /**
     * Scheduling priority inherited by descendant task nodes as their default.
     * Defaults to MERGE_QUEUE_PRIORITY (1000, well above the task default of 0)
     * so that once work is ready to land, landing outranks starting new work
     * when runnable tasks compete for scarce concurrency slots. An explicit
     * `priority` on a child node wins. Never overrides dependencies or caps.
     */
    priority?: number;
    failurePolicy?: "halt" | "quarantine";
    skipIf?: boolean;
    children?: React__default.ReactNode;
};

type ColumnTaskProps = Omit<Partial<TaskProps$2<unknown>>, "agent" | "children" | "id" | "key" | "output" | "smithersContext">;
type ColumnDef$1 = {
    name: string;
    agent: AgentLike$2;
    /** Output schema for tasks in this column. */
    output: OutputTarget$1;
    /** Prompt template. Receives `{ item, column }` and returns a string. */
    prompt?: (ctx: {
        item: unknown;
        column: string;
    }) => string;
    /** Optional Task props applied to each generated item task in this column. */
    task?: ColumnTaskProps;
};

type KanbanProps$2 = {
    id?: string;
    /** Column definitions in order. Items flow left to right. */
    columns: ColumnDef$1[];
    /** Function that returns ticket items to process. Each item must have an `id` field. */
    useTickets: () => Array<{
        id: string;
        [key: string]: unknown;
    }>;
    /** Record mapping column names to agents. Overrides column-level agents. */
    agents?: Record<string, AgentLike$2>;
    /** Max items processed in parallel per column. */
    maxConcurrency?: number;
    /** Callback output schema when an item reaches the final column. */
    onComplete?: OutputTarget$1;
    /** Whether the board loop is done. When true, the loop exits. */
    until?: boolean;
    /** Max iterations through the column pipeline. */
    maxIterations?: number;
    skipIf?: boolean;
    children?: React__default.ReactNode | Record<string, unknown>;
};

type HumanTaskProps$2 = {
    id: string;
    /** Where to store the human's response. */
    output: OutputTarget$1;
    /** Zod schema the human must conform to. Used for validation. */
    outputSchema?: z.ZodObject<z.ZodRawShape>;
    /** Instructions for the human (string or ReactNode). */
    prompt: string | React__default.ReactNode;
    /** Max validation retries before failure. */
    maxAttempts?: number;
    /** Do not block unrelated downstream flow while waiting for human input. */
    async?: boolean;
    skipIf?: boolean;
    timeoutMs?: number;
    continueOnFail?: boolean;
    /** Explicit dependency on other task node IDs. */
    dependsOn?: string[];
    /** Named dependencies on other tasks. Keys become context keys, values are task node IDs. */
    needs?: Record<string, string>;
    label?: string;
    meta?: Record<string, unknown>;
    key?: string;
};

type GatherAndSynthesizeProps$2 = {
    id?: string;
    /** Record mapping source names to source definitions. */
    sources: Record<string, SourceDef$1>;
    /** Agent that synthesizes gathered data. */
    synthesizer: AgentLike$2;
    /** Default output schema for each source gather task. */
    gatherOutput: OutputTarget$1;
    /** Output schema for the synthesis task. */
    synthesisOutput: OutputTarget$1;
    /** Gathered results keyed by source name. Typically from ctx.outputMaybe(). */
    gatheredResults?: Record<string, unknown> | null;
    /** Max parallel gatherers. */
    maxConcurrency?: number;
    /** Prompt for the synthesis task. If omitted, a default prompt is generated. */
    synthesisPrompt?: string;
    skipIf?: boolean;
    children?: React__default.ReactNode;
};

type EscalationLevel$1 = {
    /** Agent to handle this escalation level. */
    agent: AgentLike$2;
    /** Output target for this level's result. */
    output: OutputTarget$1;
    /** Display label for this level. */
    label?: string;
    /** Predicate evaluated on the level's result. Return `true` to escalate. */
    escalateIf?: (result: unknown) => boolean;
};

type EscalationChainProps$2 = {
    /** ID prefix for generated nodes. */
    id?: string;
    /** Ordered escalation levels. Each level runs only if the previous escalated. */
    levels: EscalationLevel$1[];
    /** If `true`, the final escalation produces a human approval node. */
    humanFallback?: boolean;
    /** Approval request config used when `humanFallback` is `true`. */
    humanRequest?: ApprovalRequest$1;
    /** Output target for escalation tracking at each level. */
    escalationOutput: OutputTarget$1;
    skipIf?: boolean;
    /** Prompt / input passed to each agent level. */
    children?: React__default.ReactNode;
};

type DriftDetectorProps$2 = {
    /** ID prefix for generated task/component ids. */
    id?: string;
    /** Agent that captures the current state snapshot. */
    captureAgent: AgentLike$2;
    /** Agent that compares current state against the baseline. */
    compareAgent: AgentLike$2;
    /** Output schema for the captured state. */
    captureOutput: OutputTarget$1;
    /** Output schema for the comparison result. Should include `drifted: boolean` and `significance: string`. */
    compareOutput: OutputTarget$1;
    /** Static baseline data, or a function/agent that fetches it. */
    baseline: unknown;
    /** Condition function that determines whether to fire the alert. If omitted, uses `comparison.drifted === true`. */
    alertIf?: (comparison: unknown) => boolean;
    /** Element to render when drift is detected (e.g. a Task that sends a notification). */
    alert?: React__default.ReactElement;
    /** If set, wraps the detector in a Loop for periodic polling. */
    poll?: {
        /** Reserved for future delayed polling; maxPolls currently controls Loop iterations. */
        intervalMs?: number;
        maxPolls?: number;
    };
    /** Skip the entire component. */
    skipIf?: boolean;
};

/**
 * Delegation-chain output tables — the single source of truth for every
 * `dc*` row shape (see the delegation-chain contract). Core, components, and
 * UI builders import these; nothing redefines them.
 *
 * Register the whole set in `createSmithers` and hand the resulting
 * `outputs` subset to the delegation composites:
 *
 * ```ts
 * const { smithers, outputs } = createSmithers({ ...delegationSchemas, ...own });
 * <DelegationChain outputs={outputs} ... />
 * ```
 */
/** Intelligence tiers, strongest → cheapest. Labels only; each maps to an AgentLike via the `agents` prop. */
declare const tierSchema: z.ZodEnum<{
    fable: "fable";
    opus: "opus";
    sonnet: "sonnet";
    haiku: "haiku";
}>;
/** Default tier ladder: fable plans root, opus plans chunks, sonnet executes leaves, haiku previews/probes. */
declare const DEFAULT_TIER_ORDER: string[];
/** Durable signal event name for live user edits (fixed by contract — the UI submits to this key). */
declare const DC_EDIT_SIGNAL: "dc-edit";
/** Durable signal event name for skipping the zero-backpressure preview phase. */
declare const DC_SKIP_PREVIEW_SIGNAL: "dc-skip-preview";
/** A delegation node's predicted (or measured) resource envelope. */
declare const estimateSchema: z.ZodObject<{
    tokens: z.ZodNumber;
    costUsd: z.ZodNumber;
    minutes: z.ZodNumber;
}, z.core.$strip>;
/** Developer-preview gate kinds: what artifact proves the node's work is showable. */
declare const devPreviewKindSchema: z.ZodEnum<{
    app: "app";
    terminal: "terminal";
    api: "api";
    "throwaway-ui": "throwaway-ui";
    slideshow: "slideshow";
}>;
/**
 * A declared backpressure gate. Approval gates are only honored when an
 * approvalPolicy prompt was provided. A `preview` gate is a DEVELOPER
 * PREVIEW: it runs AFTER the node's execution, its successful build
 * (`builtOk`) is REQUIRED for the node to pass, and its artifact carries the
 * UI's invalidate / request-changes affordances (which emit dc-edit rounds).
 */
declare const gateSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    method: z.ZodLiteral<"review">;
    tier: z.ZodEnum<{
        fable: "fable";
        opus: "opus";
        sonnet: "sonnet";
        haiku: "haiku";
    }>;
    brief: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    method: z.ZodLiteral<"check">;
    command: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    method: z.ZodLiteral<"approval">;
    policyMatch: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    method: z.ZodLiteral<"preview">;
    kind: z.ZodEnum<{
        app: "app";
        terminal: "terminal";
        api: "api";
        "throwaway-ui": "throwaway-ui";
        slideshow: "slideshow";
    }>;
    brief: z.ZodString;
}, z.core.$strip>], "method">;
/**
 * Final refined goal. Written by the goal-refinement agent, then re-written by
 * the human approval HumanTask. Defaults keep degraded agent output moving
 * toward the approval gate (where a human sees and can reject it) instead of
 * burning validation retries — the GrillMe precedent.
 */
declare const dcGoalSchema: z.ZodObject<{
    logicalId: z.ZodDefault<z.ZodString>;
    refinedPrompt: z.ZodDefault<z.ZodString>;
    assumptions: z.ZodDefault<z.ZodArray<z.ZodString>>;
    questionsAsked: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>;
/** Rendered form metadata for one goal-refinement question (haiku prefetch renders these ahead of the user). */
declare const dcQuestionSchema: z.ZodObject<{
    logicalId: z.ZodString;
    seq: z.ZodNumber;
    question: z.ZodString;
    header: z.ZodString;
    kind: z.ZodEnum<{
        text: "text";
        select: "select";
        confirm: "confirm";
    }>;
    options: z.ZodOptional<z.ZodArray<z.ZodObject<{
        label: z.ZodString;
        description: z.ZodString;
    }, z.core.$strip>>>;
    recommended: z.ZodString;
    reason: z.ZodString;
    resolved: z.ZodBoolean;
}, z.core.$strip>;
/**
 * The goal agent's upfront question forecast (raw JSON batch). Internal to the
 * components package: a smithers task writes exactly one row, so the batch of
 * questions rides one dcForecast row and per-question haiku tasks fan out
 * dcQuestion rows from it.
 */
declare const dcForecastSchema: z.ZodObject<{
    logicalId: z.ZodDefault<z.ZodString>;
    total: z.ZodDefault<z.ZodNumber>;
    questions: z.ZodDefault<z.ZodArray<z.ZodObject<{
        seq: z.ZodNumber;
        question: z.ZodString;
        kind: z.ZodEnum<{
            text: "text";
            select: "select";
            confirm: "confirm";
        }>;
        options: z.ZodOptional<z.ZodArray<z.ZodObject<{
            label: z.ZodString;
            description: z.ZodString;
        }, z.core.$strip>>>;
        recommended: z.ZodString;
        reason: z.ZodString;
    }, z.core.$strip>>>;
}, z.core.$strip>;
/**
 * The human's refined-prompt approval (internal): the delegation UI submits
 * `{ approved, refinedPrompt }` to the `dc:<goal>:approve` HumanTask, and the
 * (possibly edited) refinedPrompt becomes the root planning brief.
 */
declare const dcGoalApprovalSchema: z.ZodObject<{
    approved: z.ZodBoolean;
    refinedPrompt: z.ZodString;
}, z.core.$strip>;
/** One row per delegating node: its children, risks, and resource estimates. Replans append superseding rows. */
declare const dcPlanSchema: z.ZodObject<{
    logicalId: z.ZodString;
    tier: z.ZodEnum<{
        fable: "fable";
        opus: "opus";
        sonnet: "sonnet";
        haiku: "haiku";
    }>;
    title: z.ZodString;
    brief: z.ZodString;
    children: z.ZodArray<z.ZodObject<{
        logicalId: z.ZodString;
        tier: z.ZodEnum<{
            fable: "fable";
            opus: "opus";
            sonnet: "sonnet";
            haiku: "haiku";
        }>;
        kind: z.ZodEnum<{
            chunk: "chunk";
            leaf: "leaf";
        }>;
        title: z.ZodString;
        brief: z.ZodString;
        estimate: z.ZodObject<{
            tokens: z.ZodNumber;
            costUsd: z.ZodNumber;
            minutes: z.ZodNumber;
        }, z.core.$strip>;
    }, z.core.$strip>>;
    subtreeEstimate: z.ZodObject<{
        tokens: z.ZodNumber;
        costUsd: z.ZodNumber;
        minutes: z.ZodNumber;
    }, z.core.$strip>;
    risks: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        description: z.ZodString;
        probe: z.ZodNullable<z.ZodEnum<{
            poc: "poc";
            research: "research";
        }>>;
        reason: z.ZodString;
    }, z.core.$strip>>;
    orchestration: z.ZodOptional<z.ZodEnum<{
        workflow: "workflow";
        tasks: "tasks";
    }>>;
}, z.core.$strip>;
/** Zero-backpressure haiku render of a leaf's expected output. NEVER executed — calibration only. */
declare const dcPreviewSchema: z.ZodObject<{
    logicalId: z.ZodString;
    expectedOutput: z.ZodString;
}, z.core.$strip>;
/** A node's declared backpressure gates and logical dependencies. */
declare const dcGatesSchema: z.ZodObject<{
    logicalId: z.ZodString;
    gates: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        method: z.ZodLiteral<"review">;
        tier: z.ZodEnum<{
            fable: "fable";
            opus: "opus";
            sonnet: "sonnet";
            haiku: "haiku";
        }>;
        brief: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        method: z.ZodLiteral<"check">;
        command: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        method: z.ZodLiteral<"approval">;
        policyMatch: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        method: z.ZodLiteral<"preview">;
        kind: z.ZodEnum<{
            app: "app";
            terminal: "terminal";
            api: "api";
            "throwaway-ui": "throwaway-ui";
            slideshow: "slideshow";
        }>;
        brief: z.ZodString;
    }, z.core.$strip>], "method">>;
    depsLogical: z.ZodArray<z.ZodString>;
}, z.core.$strip>;
/**
 * A developer-preview gate's built artifact (physical node phase
 * `dev-preview`). `builtOk: false` fails the gate like a failed review —
 * the node redelegates with the failure folded into the next attempt.
 */
declare const dcDevPreviewSchema: z.ZodObject<{
    logicalId: z.ZodString;
    kind: z.ZodEnum<{
        app: "app";
        terminal: "terminal";
        api: "api";
        "throwaway-ui": "throwaway-ui";
        slideshow: "slideshow";
    }>;
    title: z.ZodString;
    builtOk: z.ZodBoolean;
    artifact: z.ZodObject<{
        type: z.ZodEnum<{
            html: "html";
            url: "url";
            markdown: "markdown";
        }>;
        content: z.ZodOptional<z.ZodString>;
        url: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    instructions: z.ZodOptional<z.ZodString>;
    summary: z.ZodString;
}, z.core.$strip>;
/** A risk probe's finding. The report is delivered to the NEAREST PARENT only. */
declare const dcProbeSchema: z.ZodObject<{
    probeId: z.ZodString;
    parentLogicalId: z.ZodString;
    kind: z.ZodEnum<{
        poc: "poc";
        research: "research";
    }>;
    question: z.ZodString;
    answer: z.ZodString;
    report: z.ZodString;
    planImpact: z.ZodEnum<{
        none: "none";
        changes: "changes";
        confirms: "confirms";
    }>;
    proposedChange: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/** A replan decision for one affected node. `invalidated` bumps the node version; prior versions stay archived. */
declare const dcReplanSchema: z.ZodObject<{
    round: z.ZodNumber;
    logicalId: z.ZodString;
    decision: z.ZodEnum<{
        invalidated: "invalidated";
        reaffirmed: "reaffirmed";
    }>;
    reason: z.ZodString;
    trigger: z.ZodObject<{
        type: z.ZodEnum<{
            probe: "probe";
            "user-edit": "user-edit";
            "review-fail": "review-fail";
        }>;
        ref: z.ZodString;
    }, z.core.$strip>;
}, z.core.$strip>;
/**
 * One execution attempt of a leaf. `actual` is best-effort self-reported
 * usage; `commitRange` is the working-copy commit measured before/after the
 * attempt (captured by the exec agent wrapper — omitted whenever capture
 * fails, never a reason to fail the exec).
 */
declare const dcExecSchema: z.ZodObject<{
    logicalId: z.ZodString;
    attempt: z.ZodNumber;
    summary: z.ZodString;
    artifacts: z.ZodArray<z.ZodString>;
    actual: z.ZodOptional<z.ZodObject<{
        tokens: z.ZodOptional<z.ZodNumber>;
        costUsd: z.ZodOptional<z.ZodNumber>;
        minutes: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    commitRange: z.ZodOptional<z.ZodObject<{
        from: z.ZodString;
        to: z.ZodString;
        vcs: z.ZodEnum<{
            jj: "jj";
            git: "git";
        }>;
    }, z.core.$strip>>;
}, z.core.$strip>;
/** A review/check gate verdict for one execution attempt. */
declare const dcReviewSchema: z.ZodObject<{
    logicalId: z.ZodString;
    attempt: z.ZodNumber;
    verdict: z.ZodEnum<{
        fail: "fail";
        pass: "pass";
    }>;
    feedback: z.ZodString;
}, z.core.$strip>;
/**
 * Approval-gate decision rows (only materialized when an approvalPolicy was
 * provided). Shape mirrors the stock `<Approval>` decision payload.
 */
declare const dcApprovalSchema: z.ZodObject<{
    approved: z.ZodBoolean;
    note: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    decidedBy: z.ZodNullable<z.ZodString>;
    decidedAt: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
/** Live user-edit signal payload (event name `dc-edit`). Each edit triggers a replan round. */
declare const dcEditSchema: z.ZodObject<{
    editId: z.ZodString;
    logicalId: z.ZodString;
    editedOutput: z.ZodUnknown;
    note: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/** Skip-previews signal payload (event name `dc-skip-preview`). */
declare const dcSkipSchema: z.ZodObject<{
    skipped: z.ZodBoolean;
}, z.core.$strip>;
/** End-of-run satisfaction poll (HumanTask json form). */
declare const dcPollSchema: z.ZodObject<{
    answers: z.ZodArray<z.ZodObject<{
        question: z.ZodString;
        rating: z.ZodNumber;
    }, z.core.$strip>>;
    comment: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/**
 * Budget-guard checkpoints (internal, written only when a `budget` prop is
 * set): rolled-up dcExec actuals compared against the caller's budget. A hard
 * breach fails the guard task (error into the run); >= 80% emits a `warn` row.
 */
declare const dcBudgetSchema: z.ZodObject<{
    logicalId: z.ZodString;
    level: z.ZodEnum<{
        warn: "warn";
        ok: "ok";
    }>;
    totalUsd: z.ZodNumber;
    maxUsd: z.ZodNullable<z.ZodNumber>;
    totalMinutes: z.ZodNumber;
    maxMinutes: z.ZodNullable<z.ZodNumber>;
}, z.core.$strip>;
/** Run-level scoring digest (internal): the row delegation run scorers evaluate. */
declare const dcScoreSchema: z.ZodObject<{
    logicalId: z.ZodString;
    summary: z.ZodString;
}, z.core.$strip>;
declare namespace delegationSchemas {
    export { dcGoalSchema as dcGoal };
    export { dcQuestionSchema as dcQuestion };
    export { dcForecastSchema as dcForecast };
    export { dcGoalApprovalSchema as dcGoalApproval };
    export { dcPlanSchema as dcPlan };
    export { dcPreviewSchema as dcPreview };
    export { dcDevPreviewSchema as dcDevPreview };
    export { dcGatesSchema as dcGates };
    export { dcProbeSchema as dcProbe };
    export { dcReplanSchema as dcReplan };
    export { dcExecSchema as dcExec };
    export { dcReviewSchema as dcReview };
    export { dcApprovalSchema as dcApproval };
    export { dcEditSchema as dcEdit };
    export { dcSkipSchema as dcSkip };
    export { dcPollSchema as dcPoll };
    export { dcBudgetSchema as dcBudget };
    export { dcScoreSchema as dcScore };
}

type Tier$3 = z.infer<typeof tierSchema>;
type Estimate$1 = z.infer<typeof estimateSchema>;
type DevPreviewKind$1 = z.infer<typeof devPreviewKindSchema>;
type Gate$1 = z.infer<typeof gateSchema>;
type DcGoalRow$1 = z.infer<typeof dcGoalSchema>;
type DcQuestionRow$1 = z.infer<typeof dcQuestionSchema>;
type DcForecastRow$1 = z.infer<typeof dcForecastSchema>;
type DcGoalApprovalRow$1 = z.infer<typeof dcGoalApprovalSchema>;
type DcPlanRow$2 = z.infer<typeof dcPlanSchema>;
type DcPreviewRow$1 = z.infer<typeof dcPreviewSchema>;
type DcGatesRow$2 = z.infer<typeof dcGatesSchema>;
type DcDevPreviewRow$1 = z.infer<typeof dcDevPreviewSchema>;
type DcProbeRow$1 = z.infer<typeof dcProbeSchema>;
type DcReplanRow$1 = z.infer<typeof dcReplanSchema>;
type DcExecRow$1 = z.infer<typeof dcExecSchema>;
type DcReviewRow$1 = z.infer<typeof dcReviewSchema>;
type DcApprovalRow$1 = z.infer<typeof dcApprovalSchema>;
type DcEditRow$1 = z.infer<typeof dcEditSchema>;
type DcSkipRow$1 = z.infer<typeof dcSkipSchema>;
type DcPollRow$1 = z.infer<typeof dcPollSchema>;
type DcBudgetRow$1 = z.infer<typeof dcBudgetSchema>;
type DcScoreRow$1 = z.infer<typeof dcScoreSchema>;

/** One agent (or failover chain) per intelligence tier. Tiers are labels only. */
type DelegationAgents$1 = Partial<Record<Tier$3, AgentLike$2 | AgentLike$2[]>>;
/**
 * Output targets for the delegation tables — pass the matching subset of
 * `createSmithers({ ...delegationSchemas }).outputs`. `dcApproval` is only
 * needed with an `approvalPolicy`, `dcBudget` only with a `budget`, and
 * `dcScore` only with run-level `scorers`.
 */
type DelegationOutputs$1 = {
    dcGoal: OutputTarget$1;
    dcQuestion: OutputTarget$1;
    dcForecast: OutputTarget$1;
    dcGoalApproval: OutputTarget$1;
    dcPlan: OutputTarget$1;
    dcPreview: OutputTarget$1;
    dcDevPreview?: OutputTarget$1;
    dcGates: OutputTarget$1;
    dcProbe: OutputTarget$1;
    dcReplan: OutputTarget$1;
    dcExec: OutputTarget$1;
    dcReview: OutputTarget$1;
    dcApproval?: OutputTarget$1;
    dcEdit: OutputTarget$1;
    dcSkip: OutputTarget$1;
    dcPoll: OutputTarget$1;
    dcBudget?: OutputTarget$1;
    dcScore?: OutputTarget$1;
};
/** Run budget. Exceeding a hard limit raises an error into the run; >= 80% emits a warning row. */
type DelegationBudget$1 = {
    maxUsd?: number;
    maxMinutes?: number;
};
/** Caller-provided scorers wired onto exec tasks, review tasks, and the run-level scoring task. */
type DelegationScorers$1 = {
    exec?: ScorersMap$1;
    review?: ScorersMap$1;
    run?: ScorersMap$1;
};
/** Props shared by every delegation phase composite. */
type DelegationSharedProps$1 = {
    /**
     * Physical node-id prefix (`<idPrefix>:<logicalId>:<phase>`). Default "dc".
     *
     * WARNING: the delegation fold and the `smithers ui` delegation UI
     * (`foldDelegation`/`delegationTableForNodeId` in
     * `@smthrs/gateway-react`) only recognize the default
     * `"dc"` prefix. A custom prefix still executes correctly, but the run
     * renders NO delegation UI until the fold learns the new prefix — keep the
     * default unless you also extend the fold.
     */
    idPrefix?: string;
    /** Agent per tier. Missing tiers fall back to the nearest configured tier. */
    agents: DelegationAgents$1;
    /** Output targets for the delegation tables (register `delegationSchemas` in createSmithers). */
    outputs: DelegationOutputs$1;
    /** When set, delegating agents may declare approval gates where this policy applies (and pass a clarified policy to children). Absent = fully automatic. */
    approvalPolicy?: string;
    /** Tier ladder, strongest first. Default ["fable", "opus", "sonnet", "haiku"]. */
    tierOrder?: Tier$3[];
    /** Max decomposition depth (default 3). */
    maxDepth?: number;
    /** Max parallel tasks per fan-out phase (default 4). */
    maxConcurrency?: number;
    /** Max replan rounds per node (default 3). */
    maxDeriskRounds?: number;
    /** Render the end-of-run satisfaction poll (default true). */
    poll?: boolean;
    /** Run budget, enforced from rolled-up dcExec actuals (and wall-clock via Aspects for maxMinutes). */
    budget?: DelegationBudget$1;
    /** Delegation scorers (e.g. from `smthrs/scorers`). */
    scorers?: DelegationScorers$1;
    skipIf?: boolean;
};

type GoalRefinementProps$2 = DelegationSharedProps$1 & {
    /** The user's original (possibly ambiguous) ask. */
    prompt: string;
    /** Max user-preference questions the goal agent may forecast (default 10). */
    maxQuestions?: number;
    /** How many question forms haiku renders ahead of the user (default 10). */
    prefetchDepth?: number;
};

type DeriskLoopProps$2 = DelegationSharedProps$1;

type BackpressurePlanningProps$2 = DelegationSharedProps$1;

type DelegationScoringProps$2 = DelegationSharedProps$1;

type DelegationPreviewProps$2 = DelegationSharedProps$1;

type DelegationPlanningProps$2 = DelegationSharedProps$1 & {
    /**
     * Root brief for standalone use. When omitted, planning waits for the
     * approved dcGoal row from the GoalRefinement phase and uses its
     * refinedPrompt.
     */
    prompt?: string;
};

type DelegationExecutionProps$2 = DelegationSharedProps$1 & {
    /** Max exec/review attempts per leaf (default 3). Attempt = loop iteration. */
    maxAttempts?: number;
};

type DelegationEditListenerProps$2 = DelegationSharedProps$1 & {
    /**
     * Stop listening when true (unmounts the armed signal wait so the run can
     * finish). DelegationChain flips this once scoring completes; standalone
     * callers compute their own condition.
     */
    until?: boolean;
    /** Max live edits accepted in one run (default 25). */
    maxEdits?: number;
};

type DelegationChainProps$2 = DelegationSharedProps$1 & {
    /** The user's original (possibly ambiguous) ask. Goal refinement turns it into the root context contract. */
    prompt: string;
    /** Max user-preference questions in goal refinement (default 10). */
    maxQuestions?: number;
    /** How many question forms haiku renders ahead of the user (default 10). */
    prefetchDepth?: number;
    /** Max exec/review attempts per leaf (default 3). */
    maxAttempts?: number;
    /** Max live edits accepted in one run (default 25). */
    maxEdits?: number;
};

type DecisionRule$1 = {
    /** Condition evaluated at render time. */
    when: boolean;
    /** Element to render when this rule matches. */
    then: React__default.ReactElement;
    /** Optional display label for the rule. */
    label?: string;
};

type DecisionTableProps$2 = {
    /** ID prefix for generated wrapper nodes. */
    id?: string;
    /** Ordered list of rules. Each rule has a `when` condition and a `then` element. */
    rules: DecisionRule$1[];
    /** Fallback element rendered when no rules match. */
    default?: React__default.ReactElement;
    /** `"first-match"` (default): first matching rule wins. `"all-match"`: all matching rules run in parallel. */
    strategy?: "first-match" | "all-match";
    skipIf?: boolean;
};

type DebateProps$2 = {
    id?: string;
    proposer: AgentLike$2;
    opponent: AgentLike$2;
    judge: AgentLike$2;
    rounds?: number;
    argumentOutput: OutputTarget$1;
    verdictOutput: OutputTarget$1;
    topic: string | React__default.ReactNode;
    skipIf?: boolean;
};

type ContinueAsNewProps$2 = {
    /**
     * Optional JSON-serializable state carried into the new run.
     */
    state?: unknown;
};

type ContentPipelineStage$1 = {
    /** Unique identifier for this stage. */
    id: string;
    /** Agent that performs this stage's work. */
    agent: AgentLike$2;
    /** Output schema for this stage. */
    output: OutputTarget$1;
    /** Human-readable label for the stage (used as task label). */
    label?: string;
};

type ContentPipelineProps$2 = {
    id?: string;
    /** Pipeline stages executed in order. Each stage receives the previous stage's output. */
    stages: ContentPipelineStage$1[];
    /** Skip the entire pipeline. */
    skipIf?: boolean;
    /** Initial prompt/content for the first stage (string or ReactNode). */
    children: string | React__default.ReactNode;
};

type CategoryConfig$1 = {
    agent: AgentLike$2;
    /** Output schema for this category's route handler. Overrides `routeOutput`. */
    output?: OutputTarget$1;
    /** Optional prompt for the route handler. Receives the classified item. */
    prompt?: (item: unknown) => string;
};

type ClassifyAndRouteProps$2 = {
    id?: string;
    /** Items to classify. A single item or an array of items. */
    items: unknown | unknown[];
    /** Record mapping category names to agents or config objects. */
    categories: Record<string, AgentLike$2 | CategoryConfig$1>;
    /** Agent that classifies items into categories. */
    classifierAgent: AgentLike$2;
    /** Output schema for the classification task. */
    classifierOutput: OutputTarget$1;
    /** Default output schema for routed work. Can be overridden per-category. */
    routeOutput: OutputTarget$1;
    /** Classification result used to drive routing. Typically from ctx.outputMaybe(). */
    classificationResult?: {
        classifications: Array<{
            itemId?: string;
            category: string;
            [key: string]: unknown;
        }>;
    } | null;
    /** Max parallel routes. */
    maxConcurrency?: number;
    skipIf?: boolean;
    children?: React__default.ReactNode;
};

type CheckConfig$1 = {
    id: string;
    agent?: AgentLike$2;
    command?: string;
    label?: string;
    /**
     * Kill `command` (SIGTERM) if it hasn't exited after this many
     * milliseconds, so a hanging check can't wedge the run. Defaults to 10
     * minutes; pass `0` to disable the timeout for this check.
     */
    timeoutMs?: number;
};

type CheckSuiteProps$2 = {
    id?: string;
    checks: CheckConfig$1[] | Record<string, Omit<CheckConfig$1, "id">>;
    verdictOutput: OutputTarget$1;
    strategy?: "all-pass" | "majority" | "any-pass";
    maxConcurrency?: number;
    continueOnFail?: boolean;
    skipIf?: boolean;
};

type BranchProps$2 = {
    if: boolean;
    then: React__default.ReactElement;
    else?: React__default.ReactElement | null;
    skipIf?: boolean;
    /**
     * `<Branch>` resolves its subtree from `then`/`else`; it takes no children.
     * Typed as `never` so passing JSX children is a compile-time error (the
     * runtime also throws — children would otherwise be silently dropped).
     */
    children?: never;
};

/**
 * Token budget configuration for Aspects.
 *
 * The engine accumulates per-run token usage and enforces `max` at
 * task-dispatch time.
 */
type TokenBudgetConfig = {
    /** Maximum total tokens across all tasks within the Aspects scope. */
    max: number;
    /** Optional per-task token limit. Not enforced yet. */
    perTask?: number;
    /** Behavior when the budget is exceeded. Default: "fail". */
    onExceeded?: "fail" | "warn" | "skip-remaining";
};

/**
 * Latency SLO configuration for Aspects.
 *
 * The engine enforces the scope-wide `maxMs` wall-clock SLO at task-dispatch
 * time, measured from the run's start.
 */
type LatencySloConfig = {
    /** Maximum total wall-clock latency in milliseconds across all tasks. */
    maxMs: number;
    /** Optional per-task latency limit in milliseconds. Not enforced yet. */
    perTask?: number;
    /** Behavior when the SLO is exceeded. Default: "fail". */
    onExceeded?: "fail" | "warn";
};

/**
 * Tracking configuration — which metrics to track.
 */
type TrackingConfig = {
    /** Track token usage. Default: true. */
    tokens?: boolean;
    /** Track latency. Default: true. */
    latency?: boolean;
};

type AspectsProps$2 = {
    /** Token budget — max total tokens, optional per-task limit, and exceeded behavior. */
    tokenBudget?: TokenBudgetConfig;
    /** Latency SLO — max total wall-clock latency and exceeded behavior. */
    latencySlo?: LatencySloConfig;
    /** Which metrics to track. Defaults to all enabled. */
    tracking?: TrackingConfig;
    /** Workflow content these aspects apply to. */
    children?: React__default.ReactNode;
};

type ApprovalMode$1 = "approve" | "select" | "rank";

type ApprovalOption$1 = {
    key: string;
    label: string;
    summary?: string;
    metadata?: Record<string, unknown>;
};

type ApprovalAutoApprove$1 = {
    after?: number;
    condition?: ((ctx: SmithersCtx$1<unknown> | null) => boolean) | (() => boolean);
    audit?: boolean;
    revertOn?: ((ctx: SmithersCtx$1<unknown> | null) => boolean) | (() => boolean);
};

type ApprovalDecision$1 = z.infer<typeof approvalDecisionSchema>;

type ApprovalProps$2<_Row = ApprovalDecision$1, Output extends OutputTarget$1 = OutputTarget$1> = {
    id: string;
    mode?: ApprovalMode$1;
    options?: ApprovalOption$1[];
    /** Where to persist the approval decision. Pass a Zod schema from `outputs` (recommended), a Drizzle table, or a string key. */
    output: Output;
    outputSchema?: z.ZodObject<z.ZodRawShape>;
    request: ApprovalRequest$1;
    onDeny?: "fail" | "continue" | "skip";
    allowedScopes?: string[];
    allowedUsers?: string[];
    autoApprove?: ApprovalAutoApprove$1;
    /** Do not block unrelated downstream flow while this approval is pending. */
    async?: boolean;
    /** Explicit dependency on other task node IDs. */
    dependsOn?: string[];
    /** Named dependencies on other tasks. Keys become context keys, values are task node IDs. */
    needs?: Record<string, string>;
    /** Accept a decision only while every bound authority row still has the proved content digest. */
    bind?: ProofBinding | ProofBinding[];
    skipIf?: boolean;
    timeoutMs?: number;
    heartbeatTimeoutMs?: number;
    heartbeatTimeout?: number;
    retries?: number;
    retryPolicy?: _smthrs_scheduler_RetryPolicy.RetryPolicy;
    continueOnFail?: boolean;
    cache?: _smthrs_scheduler_CachePolicy.CachePolicy;
    label?: string;
    meta?: Record<string, unknown>;
    key?: string;
    children?: React__default.ReactNode;
    smithersContext?: React__default.Context<SmithersCtx$1<unknown> | null>;
};

type ApprovalRanking$1 = z.infer<typeof approvalRankingSchema>;

/**
 * @template Row
 * @param {ApprovalProps<Row>} props
 * @returns {React.ReactElement | null}
 */
declare function Approval<Row>(props: ApprovalProps$1<Row>): React__default.ReactElement | null;
/** @typedef {import("./ApprovalAutoApprove.ts").ApprovalAutoApprove} ApprovalAutoApprove */
/** @typedef {import("./ApprovalMode.ts").ApprovalMode} ApprovalMode */
/** @typedef {import("./ApprovalOption.ts").ApprovalOption} ApprovalOption */
/**
 * @template Row, Output
 * @typedef {import("./ApprovalProps.ts").ApprovalProps<Row, Output>} ApprovalProps
 */
declare const approvalDecisionSchema: z.ZodObject<{
    approved: z.ZodBoolean;
    note: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    decidedBy: z.ZodNullable<z.ZodString>;
    decidedAt: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
declare const approvalSelectionSchema: z.ZodObject<{
    selected: z.ZodString;
    notes: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
declare const approvalRankingSchema: z.ZodObject<{
    ranked: z.ZodArray<z.ZodString>;
    notes: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
type ApprovalProps$1<Row, Output> = ApprovalProps$2<Row, Output>;

type ApprovalSelection$1 = z.infer<typeof approvalSelectionSchema>;

type ApprovalGateProps$2 = {
    id: string;
    /** Where to persist the approval decision. */
    output: OutputTarget$1;
    /** Human-facing approval request. */
    request: ApprovalRequest$1;
    /** When `true`, approval is required. When `false`, auto-approves. */
    when: boolean;
    /** Behavior after denial. */
    onDeny?: "fail" | "continue" | "skip";
    skipIf?: boolean;
    timeoutMs?: number;
    heartbeatTimeoutMs?: number;
    heartbeatTimeout?: number;
    retries?: number;
    retryPolicy?: RetryPolicy$1;
    continueOnFail?: boolean;
};

/** @typedef {import("./WorkflowProps.ts").WorkflowProps} WorkflowProps */
/**
 * @param {WorkflowProps} props
 * @returns {React.DOMElement<WorkflowProps, Element>}
 */
declare function Workflow(props: WorkflowProps$1): React__default.DOMElement<WorkflowProps$1, Element>;
type WorkflowProps$1 = WorkflowProps$2;

/** @typedef {import("@smthrs/agents/AgentLike").AgentLike} AgentLike */
/** @typedef {import("./DepsSpec.ts").DepsSpec} DepsSpec */
/**
 * @template Row, Output, D
 * @typedef {import("./TaskProps.ts").TaskProps<Row, Output, D>} TaskProps
 */
/**
 * Shared core behind both Task variants:
 *  - `Task.js` (Node): CLI-tool-allowlist enforcement rewrites CLI agent
 *    instances (ClaudeCodeAgent/PiAgent/GeminiAgent/AntigravityAgent), which
 *    requires statically importing those Node-only (`node:child_process`)
 *    classes.
 *  - `Task.browser.js` (browser): everything else — deps resolution,
 *    agent-chain building, MDX prompt rendering via `renderToStaticMarkup`
 *    (browser-safe), static/compute branching — is identical, so it lives
 *    here and is parameterized over `applyCliToolAllowlist` instead of
 *    duplicating this ~150 lines of logic and risking the two variants
 *    drifting apart.
 *
 * This module itself imports nothing Node-only, so importing it does not
 * pull `node:child_process` into a browser bundle; only `cliToolAllowlist.js`
 * (imported by `Task.js`, not by `Task.browser.js`) does that.
 */
/**
 * Render a prompt React node to plain markdown text.
 *
 * If the prompt is a React element (e.g. a compiled MDX component), we inject
 * `markdownComponents` via the standard MDX `components` prop so that
 * renderToStaticMarkup outputs clean markdown instead of HTML. The static
 * render entity-escapes all text, so we decode the entities back to literal
 * characters before handing the prompt to the agent.
 * @param {unknown} prompt
 * @returns {string}
 */
declare function renderPromptToText(prompt: unknown): string;

/**
 * The Node/CLI-agent-aware `Task`. Every render-path behavior (deps
 * resolution, agent-chain assembly, MDX prompt rendering, static/compute/agent
 * branching) lives in `taskCore.js`; this file only supplies the CLI-agent
 * tool-allowlist enforcement step (`applyCliToolAllowlist`, which statically
 * imports `ClaudeCodeAgent`/`PiAgent`/`GeminiAgent`/`AntigravityAgent` — see
 * `cliToolAllowlist.js`). `Task.browser.js` builds the same component with a
 * no-op allowlist step instead, so it never pulls those Node-only
 * (`node:child_process`-backed) classes into a browser bundle.
 */
declare const Task: <Row, Output, D>(props: TaskProps<Row, Output, D>) => React.ReactElement | null;

/** @typedef {import("./SequenceProps.ts").SequenceProps} SequenceProps */
/**
 * @param {SequenceProps} props
 */
declare function Sequence(props: SequenceProps$1): React__default.ReactElement<{
    failurePolicy?: "halt" | "quarantine" | undefined;
    label?: string | undefined;
}, string | React__default.JSXElementConstructor<any>> | null;
type SequenceProps$1 = SequenceProps$2;

/** @typedef {import("./ParallelProps.ts").ParallelProps} ParallelProps */
/**
 * @param {ParallelProps} props
 */
declare function Parallel(props: ParallelProps$1): React__default.ReactElement<{
    failurePolicy?: "halt" | "quarantine" | undefined;
    priority?: number | undefined;
    label?: string | undefined;
    maxConcurrency: number | undefined;
    subtreeConcurrency: number | undefined;
    id: string | undefined;
}, string | React__default.JSXElementConstructor<any>> | null;
type ParallelProps$1 = ParallelProps$2;

/** @typedef {import("./MergeQueueProps.ts").MergeQueueProps} MergeQueueProps */
/**
 * @param {MergeQueueProps} props
 */
declare function MergeQueue(props: MergeQueueProps$1): React__default.ReactElement<{
    id: string | undefined;
    failurePolicy?: "halt" | "quarantine" | undefined;
    maxConcurrency: number;
    priority: number;
}, string | React__default.JSXElementConstructor<any>> | null;
type MergeQueueProps$1 = MergeQueueProps$2;

/** @typedef {import("./BranchProps.ts").BranchProps} BranchProps */
/**
 * @param {BranchProps} props
 */
declare function Branch(props: BranchProps$1): React__default.DOMElement<{}, Element> | null;
type BranchProps$1 = BranchProps$2;

/** @typedef {import("./WorktreeProps.ts").WorktreeProps} WorktreeProps */
/**
 * @param {WorktreeProps} props
 */
declare function Worktree(props: WorktreeProps$1): React__default.ReactElement<{
    id: string | undefined;
    path: string;
    branch: string | undefined;
    baseBranch: string | undefined;
}, string | React__default.JSXElementConstructor<any>> | null;
type WorktreeProps$1 = WorktreeProps$2;

/**
 * <Kanban> — Process items through columns with pluggable ticket source.
 *
 * Composes Loop, Sequence, Parallel, and Task to create a board where items
 * flow through columns. Each column processes items via its assigned agent.
 * Items in the same column can be processed in parallel.
 * @param {KanbanProps} props
 */
declare function Kanban(props: KanbanProps$1): React__default.FunctionComponentElement<SequenceProps$2> | React__default.FunctionComponentElement<LoopProps$2> | null;
type KanbanProps$1 = KanbanProps$2;

/**
 * <ClassifyAndRoute> — Classify items then route to category-specific agents.
 *
 * Composes Sequence, Task, and Parallel. First a classifier Task assigns items
 * to categories, then a Parallel block routes each classified item to the
 * appropriate category agent.
 * @param {ClassifyAndRouteProps} props
 */
declare function ClassifyAndRoute(props: ClassifyAndRouteProps$1): React__default.FunctionComponentElement<SequenceProps$2> | null;
type ClassifyAndRouteProps$1 = ClassifyAndRouteProps$2;

/**
 * <GatherAndSynthesize> — Parallel data collection from different sources,
 * then synthesis into a unified result.
 *
 * Composes Sequence, Parallel, and Task. First a Parallel block gathers data
 * from each source agent, then a synthesis Task receives all gathered data
 * and produces a combined output.
 * @param {GatherAndSynthesizeProps} props
 */
declare function GatherAndSynthesize(props: GatherAndSynthesizeProps$1): React__default.FunctionComponentElement<SequenceProps$2> | null;
type GatherAndSynthesizeProps$1 = GatherAndSynthesizeProps$2;

/**
 * <Panel> — Parallel specialists review the same input, then a moderator synthesizes.
 *
 * Composes: Sequence > Parallel[Task per panelist] > Task(moderator)
 * @param {PanelProps} props
 */
declare function Panel(props: PanelProps$1): React__default.FunctionComponentElement<SequenceProps$2> | null;
type PanelProps$1 = PanelProps$2;

/**
 * <CheckSuite> — Parallel checks with auto-aggregated pass/fail verdict.
 *
 * Composes: Sequence > Parallel[Task per check] > Task(verdict aggregator)
 * @param {CheckSuiteProps} props
 */
declare function CheckSuite(props: CheckSuiteProps$1): React__default.FunctionComponentElement<SequenceProps$2> | null;
type CheckSuiteProps$1 = CheckSuiteProps$2;

/**
 * <Debate> — Adversarial rounds with rebuttals, followed by a judge verdict.
 *
 * Composes: Sequence > Loop[Parallel(proposer, opponent)] > Task(judge)
 * @param {DebateProps} props
 */
declare function Debate(props: DebateProps$1): React__default.FunctionComponentElement<SequenceProps$2> | null;
type DebateProps$1 = DebateProps$2;

/**
 * Produce -> review -> fix -> repeat until approved.
 *
 * Composes Loop, Sequence, and Task to create a standard
 * review-loop pattern. The producer receives the reviewer's
 * feedback on subsequent iterations.
 * @param {ReviewLoopProps} props
 */
declare function ReviewLoop(props: ReviewLoopProps$1): React__default.FunctionComponentElement<LoopProps$2> | null;
type ReviewLoopProps$1 = ReviewLoopProps$2;

/**
 * Generate -> evaluate -> improve loop with score convergence.
 *
 * Composes Loop, Sequence, and Task to create an iterative
 * optimization pattern. Each iteration receives the previous
 * score and feedback to guide improvement.
 * @param {OptimizerProps} props
 */
declare function Optimizer(props: OptimizerProps$1): React__default.FunctionComponentElement<LoopProps$2> | null;
type OptimizerProps$1 = OptimizerProps$2;

/**
 * Progressive content refinement: outline -> draft -> edit -> publish.
 *
 * Composes Sequence and Task to create a typed waterfall where each
 * stage is explicitly defined. Each Task uses `needs` to depend on
 * the previous stage, passing output forward through the pipeline.
 * @param {ContentPipelineProps} props
 */
declare function ContentPipeline(props: ContentPipelineProps$1): React__default.FunctionComponentElement<SequenceProps$2> | null;
type ContentPipelineProps$1 = ContentPipelineProps$2;

/**
 * Conditional approval gate. Requires human approval only when `when` is true;
 * otherwise auto-approves with a static `{ approved: true }` decision.
 *
 * Composes Branch + Approval + Task internally.
 * @param {ApprovalGateProps} props
 */
declare function ApprovalGate(props: ApprovalGateProps$1): React__default.FunctionComponentElement<BranchProps$2> | null;
type ApprovalGateProps$1 = ApprovalGateProps$2;

/**
 * Escalation chain: tries agents in order, escalating on failure or when
 * `escalateIf` returns `true`. Optionally ends with a human approval fallback.
 *
 * Composes Sequence + Task (with `continueOnFail`) + Branch + Approval.
 * @param {EscalationChainProps} props
 */
declare function EscalationChain(props: EscalationChainProps$1): React__default.FunctionComponentElement<SequenceProps$2> | null;
type EscalationChainProps$1 = EscalationChainProps$2;

/**
 * Structured deterministic routing. Replaces deeply nested Branches with a
 * flat, declarative rule table.
 *
 * - `"first-match"` builds nested Branch elements so the first matching rule wins.
 * - `"all-match"` gathers all matching rules' `then` elements into a Parallel.
 *
 * Composes Branch and Parallel internally.
 * @param {DecisionTableProps} props
 */
declare function DecisionTable(props: DecisionTableProps$1): React__default.ReactElement<unknown, string | React__default.JSXElementConstructor<any>> | React__default.FunctionComponentElement<ParallelProps$2> | null;
type DecisionTableProps$1 = DecisionTableProps$2;

/**
 * @param {DriftDetectorProps} props
 */
declare function DriftDetector(props: DriftDetectorProps$1): React__default.FunctionComponentElement<SequenceProps$2> | React__default.FunctionComponentElement<LoopProps$2> | null;
type DriftDetectorProps$1 = DriftDetectorProps$2;

/** @typedef {import("./ScanFixVerifyProps.ts").ScanFixVerifyProps} ScanFixVerifyProps */
/**
 * @param {ScanFixVerifyProps} props
 */
declare function ScanFixVerify(props: ScanFixVerifyProps$1): React__default.FunctionComponentElement<SequenceProps$2> | null;
type ScanFixVerifyProps$1 = ScanFixVerifyProps$2;

/**
 * @param {PollerProps} props
 */
declare function Poller(props: PollerProps$1): React__default.FunctionComponentElement<LoopProps$2> | null;
type PollerProps$1 = PollerProps$2;

/**
 * <Monitor> — a heartbeat health check that watches ONE other run and keeps it
 * healthy.
 *
 * Shape, per beat: `<Timer>` paces the loop, one agent `<Task>` samples the
 * watched run and classifies it into exactly one {@link MonitorCondition}, and
 * a `<DecisionTable>` routes that condition to its handler.
 *
 * `<DecisionTable>` is the router rather than `<ClassifyAndRoute>` because the
 * two solve different problems: `<ClassifyAndRoute>` classifies MANY items and
 * fans every category out in `<Parallel>`, while a monitor has exactly one
 * subject (the watched run) and needs first-match, one-handler-wins semantics —
 * which is precisely `<DecisionTable strategy="first-match">`. Routing here is
 * deterministic: the agent names a condition, the table picks the handler.
 *
 * The healing half is deliberately timid. Only ownerless `stalled` and
 * `wedged-node` runs heal without a human by default. A live owner is never
 * taken over by the monitor; that condition escalates through a durable
 * `<HumanTask>`. Put a condition in `autoHeal` to grant broader authority; pass
 * `handlers` to replace any element outright, or map one to `null` to make it a
 * no-op.
 *
 * The monitor never reads the store: its prompt binds it to the Gateway client
 * and the public CLI surface.
 *
 * @param {MonitorProps} props
 */
declare function Monitor(props: MonitorProps$1): React__default.FunctionComponentElement<LoopProps$2> | null;
type MonitorProps$1 = MonitorProps$2;

/**
 * <Supervisor> — Boss plans, delegates to parallel workers, reviews, re-delegates failures.
 *
 * Composes: Sequence → [plan Task, Loop(until allDone) [Parallel worker Tasks, review Task], final Task]
 * @param {SupervisorProps} props
 */
declare function Supervisor(props: SupervisorProps$1): React__default.FunctionComponentElement<SequenceProps$2> | null;
type SupervisorProps$1 = SupervisorProps$2;

/**
 * <Runbook> — Sequential steps with risk classification.
 *
 * Safe steps auto-execute. Risky and critical steps require human approval first.
 * Composes: Sequence of [Approval? → Task] per step, chained via `needs`.
 * @param {RunbookProps} props
 */
declare function Runbook(props: RunbookProps$1): React__default.FunctionComponentElement<SequenceProps$2> | null;
type RunbookProps$1 = RunbookProps$2;

/**
 * Runs a primary task and a cheap shadow task over the same prompt.
 *
 * The primary task keeps the component id so downstream `needs` can consume it.
 * The sidecar task is continue-on-fail and writes its own scorer rows.
 *
 * @param {SidecarProps} props
 */
declare function Sidecar(props: SidecarProps$1): React__default.FunctionComponentElement<ParallelProps$2> | null;
type SidecarProps$1 = SidecarProps$2;

/**
 * @param {RowLike[]} rows
 * @param {ComputeSidecarDeltaOptions} opts
 * @returns {SidecarDelta}
 */
declare function computeSidecarDelta(rows: RowLike[], opts: ComputeSidecarDeltaOptions): SidecarDelta$1;
type SidecarDelta$1 = SidecarDelta$2;
type RowLike = Record<string, unknown> & {
    nodeId?: string;
    node_id?: string;
    scorerId?: string;
    scorer_id?: string;
    score?: number;
    scoredAtMs?: number;
    scored_at_ms?: number;
};
type ComputeSidecarDeltaOptions = {
    primaryNodeId: string;
    sidecarNodeId: string;
    scorerId?: string | undefined;
};

/** @typedef {import("./SubflowProps.ts").SubflowProps} SubflowProps */
/**
 * @param {SubflowProps} props
 */
declare function Subflow(props: SubflowProps$1): React__default.ReactElement<{
    id: string;
    workflow: WorkflowFileRef$1 | _smthrs_driver.WorkflowDefinition<unknown>;
    input: unknown;
    mode: "childRun" | "inline";
    output: OutputTarget$1;
    timeoutMs: number | undefined;
    heartbeatTimeoutMs: number | undefined;
    heartbeatTimeout: number | undefined;
    retries: number | undefined;
    retryPolicy: {
        backoff?: "fixed" | "linear" | "exponential";
        initialDelayMs?: number;
    } | undefined;
    continueOnFail: boolean | undefined;
    cache: _smthrs_scheduler.CachePolicy | undefined;
    dependsOn: string[] | undefined;
    needs: Record<string, string> | undefined;
    label: string;
    meta: Record<string, unknown> | undefined;
    __smithersSubflowWorkflow: WorkflowFileRef$1 | _smthrs_driver.WorkflowDefinition<unknown>;
    __smithersSubflowInput: unknown;
    __smithersSubflowMode: "childRun" | "inline";
}, string | React__default.JSXElementConstructor<any>> | null;
type SubflowProps$1 = SubflowProps$2;

/** @typedef {import("./SandboxProps.ts").SandboxProps} SandboxProps */
/**
 * @param {SandboxProps} props
 */
declare function Sandbox(props: SandboxProps$1): React__default.ReactElement<{
    id: string;
    output: OutputTarget$1;
    provider: unknown;
    runtime: SandboxRuntime$1 | undefined;
    allowNetwork: boolean | undefined;
    reviewDiffs: boolean | undefined;
    autoAcceptDiffs: boolean | undefined;
    allowNested: boolean | undefined;
    image: string | undefined;
    env: Record<string, string> | undefined;
    egress: SandboxEgressConfig$1 | undefined;
    ports: {
        host: number;
        container: number;
    }[] | undefined;
    volumes: SandboxVolumeMount$1[] | undefined;
    memoryLimit: string | undefined;
    cpuLimit: string | undefined;
    command: string | undefined;
    workspace: SandboxWorkspaceSpec$1 | undefined;
    timeoutMs: number | undefined;
    heartbeatTimeoutMs: number | undefined;
    heartbeatTimeout: number | undefined;
    retries: number | undefined;
    retryPolicy: {
        backoff?: "fixed" | "linear" | "exponential";
        initialDelayMs?: number;
    } | undefined;
    continueOnFail: boolean | undefined;
    cache: _smthrs_scheduler.CachePolicy | undefined;
    dependsOn: string[] | undefined;
    needs: Record<string, string> | undefined;
    label: string;
    meta: Record<string, unknown> | undefined;
    __smithersSandboxProvider: unknown;
    __smithersSandboxWorkflow: _smthrs_driver.WorkflowDefinition<unknown> | undefined;
    __smithersSandboxInput: unknown;
    __smithersSandboxRuntime: SandboxRuntime$1 | undefined;
    __smithersSandboxAllowNested: boolean | undefined;
    __smithersSandboxChildren: React__default.ReactNode;
}, string | React__default.JSXElementConstructor<any>> | null;
type SandboxProps$1 = SandboxProps$2;

/** @typedef {import("./WaitForEventProps.ts").WaitForEventProps} WaitForEventProps */
/**
 * @param {WaitForEventProps} props
 */
declare function WaitForEvent(props: WaitForEventProps$1): React__default.ReactElement<{
    id: string;
    event: string;
    correlationId: string | undefined;
    output: OutputTarget$1;
    outputSchema: zod.ZodObject<Readonly<{
        [k: string]: zod_v4_core.$ZodType<unknown, unknown, zod_v4_core.$ZodTypeInternals<unknown, unknown>>;
    }>, zod_v4_core.$strip> | undefined;
    timeoutMs: number | undefined;
    onTimeout: "fail" | "continue" | "skip";
    waitAsync: boolean;
    dependsOn: string[] | undefined;
    needs: Record<string, string> | undefined;
    label: string;
    meta: {
        onTimeout?: "fail" | "continue" | "skip" | undefined;
        correlationId?: string | undefined;
        event: string;
    } | undefined;
    __smithersEventName: string;
    __smithersCorrelationId: string | undefined;
    __smithersOnTimeout: "fail" | "continue" | "skip";
    __smithersTaggedResult: boolean;
}, string | React__default.JSXElementConstructor<any>> | null;
type WaitForEventProps$1 = WaitForEventProps$2;

/**
 * @template Schema
 * @typedef {import("./SignalProps.ts").SignalProps<Schema>} SignalProps
 */
/**
 * @template Schema
 * @param {SignalProps<Schema>} props
 */
declare function Signal<Schema>(props: SignalProps$1<Schema>): React__default.DetailedReactHTMLElement<React__default.InputHTMLAttributes<HTMLInputElement>, HTMLInputElement> | React__default.FunctionComponentElement<React__default.FragmentProps> | null;
type SignalProps$1<Schema> = SignalProps$2<Schema>;

/** @typedef {import("./TimerProps.ts").TimerProps} TimerProps */
/**
 * @param {TimerProps} props
 */
declare function Timer(props: TimerProps$1): React__default.ReactElement<{
    id: string;
    duration: string | undefined;
    until: string | undefined;
    dependsOn: string[] | undefined;
    needs: Record<string, string> | undefined;
    label: string;
    meta: {
        until?: string | undefined;
        duration?: string | undefined;
        timer: boolean;
    } | undefined;
    __smithersTimerDuration: string | undefined;
    __smithersTimerUntil: string | undefined;
}, string | React__default.JSXElementConstructor<any>> | null;
type TimerProps$1 = TimerProps$2;

/**
 * @param {HumanTaskProps} props
 * @returns {React.ReactElement | null}
 */
declare function HumanTask(props: HumanTaskProps$1): React__default.ReactElement | null;
type HumanTaskProps$1 = HumanTaskProps$2;

/**
 * Workflow-scoped error boundary. Catch specific error types, run recovery
 * handlers, and ensure cleanup always runs.
 *
 * - The `try` block is the main workflow content.
 * - If any task in `try` fails with a matching error, the `catch` block mounts.
 * - The `finally` block always runs after try (success) or catch (failure).
 *
 * Renders to `<smithers:try-catch-finally>`.
 * @param {TryCatchFinallyProps} props
 */
declare function TryCatchFinally(props: TryCatchFinallyProps$1): React__default.ReactElement<{
    id: string | undefined;
    catchErrors: string | undefined;
    __tcfCatchErrors: ("INVALID_INPUT" | "MISSING_INPUT" | "MISSING_INPUT_TABLE" | "RESUME_METADATA_MISMATCH" | "UNKNOWN_OUTPUT_SCHEMA" | "INVALID_OUTPUT" | "WORKTREE_CREATE_FAILED" | "VCS_NOT_FOUND" | "SNAPSHOT_NOT_FOUND" | "VCS_WORKSPACE_CREATE_FAILED" | "TASK_TIMEOUT" | "TASK_HIJACK_UNSUPPORTED" | "TASK_FORK_SOURCE_NOT_FOUND" | "TASK_FORK_SOURCE_NOT_COMPLETE" | "TASK_FORK_SESSION_UNAVAILABLE" | "TASK_FORK_CYCLE" | "RUN_NOT_FOUND" | "NODE_NOT_FOUND" | "INVALID_EVENTS_OPTIONS" | "SANDBOX_BUNDLE_INVALID" | "SANDBOX_BUNDLE_TOO_LARGE" | "WORKFLOW_EXECUTION_FAILED" | "SANDBOX_EXECUTION_FAILED" | "TASK_HEARTBEAT_TIMEOUT" | "HEARTBEAT_PAYLOAD_TOO_LARGE" | "HEARTBEAT_PAYLOAD_NOT_JSON_SERIALIZABLE" | "TASK_ABORTED" | "RUN_CANCELLED" | "RUN_NOT_RESUMABLE" | "RUN_OWNER_ALIVE" | "RUN_STILL_RUNNING" | "RUN_RESUME_CLAIM_LOST" | "RUN_RESUME_CLAIM_FAILED" | "RUN_RESUME_ACTIVATION_FAILED" | "AUTO_RESUME_GAVE_UP" | "RUN_HIJACKED" | "CONTINUATION_STATE_TOO_LARGE" | "INVALID_CONTINUATION_STATE" | "RALPH_MAX_REACHED" | "SCHEDULER_ERROR" | "SESSION_ERROR" | "TASK_ID_REQUIRED" | "TASK_MISSING_OUTPUT" | "TASK_EMPTY_PROMPT" | "WORKFLOW_RENDER_FAILED" | "DUPLICATE_ID" | "NESTED_LOOP" | "WORKTREE_EMPTY_PATH" | "MDX_PRELOAD_INACTIVE" | "CONTEXT_OUTSIDE_WORKFLOW" | "MISSING_OUTPUT" | "DEP_NOT_SATISFIED" | "BOUND_STALE" | "ASPECT_BUDGET_EXCEEDED" | "APPROVAL_OUTSIDE_TASK" | "APPROVAL_OPTIONS_REQUIRED" | "WORKFLOW_MISSING_DEFAULT" | "WORKFLOW_NOT_BUILT" | "TOOL_PATH_INVALID" | "TOOL_PATH_ESCAPE" | "TOOL_FILE_TOO_LARGE" | "TOOL_CONTENT_TOO_LARGE" | "TOOL_PATCH_TOO_LARGE" | "TOOL_PATCH_FAILED" | "TOOL_NETWORK_DISABLED" | "TOOL_GIT_REMOTE_DISABLED" | "TOOL_COMMAND_FAILED" | "TOOL_GREP_FAILED" | "AGENT_CLI_ERROR" | "AGENT_CONFIG_INVALID" | "AGENT_QUOTA_EXCEEDED" | "AGENT_RPC_FILE_ARGS" | "AGENT_BUILD_COMMAND" | "AGENT_DIAGNOSTIC_TIMEOUT" | "ACCOUNT_INVALID" | "ACCOUNT_NOT_FOUND" | "ACCOUNT_DUPLICATE_LABEL" | "ACCOUNTS_FILE_INVALID" | "DB_MISSING_COLUMNS" | "DB_REQUIRES_BUN_SQLITE" | "DB_QUERY_FAILED" | "DB_WRITE_FAILED" | "PG_POOL_SATURATED" | "SMITHERS_MIGRATION_REQUIRED" | "SMITHERS_BACKEND_CONFLICT" | "STORAGE_ERROR" | "INTERNAL_ERROR" | "PROCESS_ABORTED" | "PROCESS_TIMEOUT" | "PROCESS_IDLE_TIMEOUT" | "PROCESS_SPAWN_FAILED" | "TASK_RUNTIME_UNAVAILABLE" | "SCHEMA_CHANGE_HOT" | "HOT_OVERLAY_FAILED" | "HOT_RELOAD_INVALID_MODULE" | "SCORER_FAILED" | "WORKFLOW_EXISTS" | "CLI_DB_NOT_FOUND" | "CLI_AGENT_UNSUPPORTED" | "PI_HTTP_ERROR" | "EXTERNAL_BUILD_FAILED" | "SCHEMA_DISCOVERY_FAILED" | "OPENAPI_SPEC_LOAD_FAILED" | "OPENAPI_OPERATION_NOT_FOUND" | "OPENAPI_TOOL_EXECUTION_FAILED" | "TIME_TRAVEL_SIDE_EFFECT_BLOCKED" | "SINGLE_RUNNER_BUSY" | "SINGLE_RUNNER_CLOSED" | (string & {}))[] | undefined;
    __tcfCatchHandler: React__default.ReactElement<unknown, string | React__default.JSXElementConstructor<any>> | ((error: _smthrs_errors.SmithersError) => React__default.ReactElement) | undefined;
    __tcfFinallyHandler: React__default.ReactElement<unknown, string | React__default.JSXElementConstructor<any>> | undefined;
}, string | React__default.JSXElementConstructor<any>> | null;
type TryCatchFinallyProps$1 = TryCatchFinallyProps$2;

/**
 * Runtime accumulator for tracked metrics within an Aspects scope.
 */
type AspectAccumulator = {
    totalTokens: number;
    totalLatencyMs: number;
    taskCount: number;
};

/**
 * The value provided by AspectContext to descendant components.
 */
type AspectContextValue = {
    tokenBudget?: TokenBudgetConfig;
    latencySlo?: LatencySloConfig;
    tracking: TrackingConfig;
    accumulator: AspectAccumulator;
};

/**
 * Aspects — declarative cross-cutting concerns for workflow scopes.
 *
 * Wraps a section of the workflow tree and propagates token budgets,
 * latency SLOs, and cost budgets to all descendant Task components
 * without modifying individual tasks. The engine enforces the scope-wide
 * budgets at task-dispatch time.
 *
 * ```tsx
 * <Aspects tokenBudget={{ max: 100_000, perTask: 20_000, onExceeded: "warn" }}>
 *   <Task id="step1" ...>...</Task>
 *   <Task id="step2" ...>...</Task>
 * </Aspects>
 * ```
 * @param {AspectsProps} props
 */
declare function Aspects(props: AspectsProps$1): React__default.FunctionComponentElement<React__default.ProviderProps<AspectContextValue | null>>;
type AspectsProps$1 = AspectsProps$2;

type MemoryContextValue = {
    bank?: string;
    banks?: string[];
    tags: string[];
    recall: "auto" | string | false;
    budget: "low" | "mid" | "high";
    maxTokens: number;
    primers: string[];
    retain: "on-complete" | "off";
    tools: boolean;
};

/**
 * Provide one memory configuration to every descendant Task.
 *
 * Nested providers inherit omitted fields. A descendant Task's explicit
 * `memory` prop replaces the inherited configuration for that task.
 *
 * @param {MemoryProps} props
 * @returns {React.FunctionComponentElement<React.ProviderProps<import("../memory/MemoryContextValue.ts").MemoryContextValue | null>>}
 */
declare function Memory(props: MemoryProps$1): React__default.FunctionComponentElement<React__default.ProviderProps<MemoryContextValue | null>>;
type MemoryProps$1 = MemoryProps$2;

/**
 * SuperSmithers — a workflow wrapper that reads and modifies source code
 * to intervene via hot reload. Takes a markdown strategy doc and an agent
 * that decides what to change.
 *
 * Only meaningful in hot-reload mode: the agent reads source files, proposes
 * modifications, and (unless `dryRun` is set) writes them to disk, triggering
 * the hot reload system to pick up the changes.
 *
 * Internally expands to a sequence of tasks:
 * 1. Agent reads the strategy doc and target files
 * 2. (If not dryRun) Agent applies the modifications directly to disk
 * 3. A compute marker records the apply and triggers the hot-reload system
 * 4. Agent generates a report of what changed
 *
 * ```tsx
 * <SuperSmithers
 *   id="refactor"
 *   strategy={strategyMd}
 *   agent={codeAgent}
 *   targetFiles={["src/**\/*.ts"]}
 *   reportOutput={outputs.report}
 * />
 * ```
 * @param {SuperSmithersProps} props
 */
declare function SuperSmithers(props: SuperSmithersProps$1): React__default.ReactElement<{
    id: string;
}, string | React__default.JSXElementConstructor<any>> | null;
type SuperSmithersProps$1 = SuperSmithersProps$2;

/**
 * <DelegationChain> — the full delegation-chain workflow composite.
 *
 * A `<Sequence>` of the seven phases (goal refinement → recursive planning →
 * zero-backpressure previews → backpressure planning → derisk probes/replans
 * → gated execution → scoring + poll) in `<Parallel>` with the live
 * `dc-edit` signal listener. Every phase is reactive: it derives its slice of
 * the tree from the dc* output rows each render, so fan-out materializes
 * level by level as rows land, and user edits/probe findings replan the
 * affected subtree without restarting anything.
 *
 * When `budget.maxMinutes` is set the whole chain is wrapped in `<Aspects>`
 * with a wall-clock `latencySlo` (engine-enforced at task dispatch); dollar
 * budgets are enforced by per-leaf guard tasks comparing rolled-up dcExec
 * actuals (hard error over the limit, warning row at >= 80%).
 *
 * Register `delegationSchemas` in `createSmithers` and pass the matching
 * `outputs` subset:
 *
 * ```tsx
 * const { smithers, outputs } = createSmithers({ ...delegationSchemas });
 * <DelegationChain
 *   prompt={ctx.input.prompt}
 *   agents={{ fable, opus, sonnet, haiku }}
 *   outputs={outputs}
 * />
 * ```
 * @param {DelegationChainProps} props
 */
declare function DelegationChain(props: DelegationChainProps$1): React__default.FunctionComponentElement<ParallelProps$2> | React__default.FunctionComponentElement<AspectsProps$2> | null;
type DelegationChainProps$1 = DelegationChainProps$2;

/**
 * <GoalRefinement> — phase 0 of the delegation chain.
 *
 * The strongest tier forecasts every genuine user-preference question upfront
 * (one dcForecast row); haiku tasks render form metadata (unresolved
 * dcQuestion rows) up to `prefetchDepth` questions ahead; the user answers one
 * durable json form at a time (each answer folds into a RESOLVED dcQuestion
 * row); then the goal agent writes the refined prompt (dcGoal) and a final
 * HumanTask lets the human edit + approve it (`{ approved, refinedPrompt }` —
 * the approved refinedPrompt is what planning builds from).
 *
 * Node ids: `<p>:goal:forecast` (internal), `<p>:goal:forms:question-<seq>`
 * (haiku form metadata), `<p>:goal:question-<seq>` (human answer — the id the
 * delegation UI targets), `<p>:goal:goal` (refine), `<p>:goal:approve`
 * (refined-prompt approval — UI-targeted).
 * @param {GoalRefinementProps} props
 */
declare function GoalRefinement(props: GoalRefinementProps$1): React__default.FunctionComponentElement<SequenceProps$2> | null;
type GoalRefinementProps$1 = GoalRefinementProps$2;

/**
 * <DelegationPlanning> — recursive decomposition fan-out.
 *
 * The strongest tier plans `root`; every child declared as a chunk fans out
 * into its own plan task (re-render materializes the next level as each plan
 * row lands) until the frontier is all leaves or `maxDepth` forces leaves.
 * Fan-out gating is by construction: a child's plan task only mounts once its
 * parent's dcPlan row exists, and its brief is captured from that row —
 * strictly stronger gating than a dependsOn edge, with the same minimal
 * working set per child.
 *
 * Node ids: `<p>:<logicalId>:plan` (path `/` encoded as `:`).
 * @param {DelegationPlanningProps} props
 */
declare function DelegationPlanning(props: DelegationPlanningProps$1): React__default.FunctionComponentElement<SequenceProps$2> | null;
type DelegationPlanningProps$1 = DelegationPlanningProps$2;

/**
 * <DelegationPreview> — zero-backpressure expected-output previews.
 *
 * Once planning completes, haiku renders every leaf's expected output
 * (dcPreview rows — ALWAYS displayed with a "never executed — calibration
 * only" warning). A durable `dc-skip-preview` signal (delivered by the UI's
 * skip button) suppresses the phase: once a dcSkip row exists, no further
 * preview tasks mount. The signal listener is async and unmounts once every
 * preview landed, so it never wedges the run.
 *
 * Node ids: `<p>:<leaf>:preview`; the skip listener is the fixed signal node
 * `dc-skip-preview`.
 * @param {DelegationPreviewProps} props
 */
declare function DelegationPreview(props: DelegationPreviewProps$1): React__default.FunctionComponentElement<SequenceProps$2> | null;
type DelegationPreviewProps$1 = DelegationPreviewProps$2;

/**
 * <BackpressurePlanning> — every node declares its gates and dependencies
 * BEFORE execution (frame 4 of the design simulation).
 *
 * One dcGates task per node in the planned tree, in parallel: delegating
 * nodes declare their own gates; a leaf's gates are declared by its parent's
 * tier. Approval gates are only permitted when an approvalPolicy prompt was
 * provided (the prompt says so explicitly either way).
 *
 * Node ids: `<p>:<logicalId>:gates`.
 * @param {BackpressurePlanningProps} props
 */
declare function BackpressurePlanning(props: BackpressurePlanningProps$1): React__default.FunctionComponentElement<SequenceProps$2> | null;
type BackpressurePlanningProps$1 = BackpressurePlanningProps$2;

/**
 * Physical smithers node id for a logical node + phase:
 * `<idPrefix>:<logicalId>:<phase>`, with `/` path separators encoded as `:`
 * — gateway node-id validation only allows `[a-zA-Z0-9:_-]`, and the
 * delegation fold parses any `:`-joined middle segments back into the
 * logical id slot. Row `logicalId` FIELDS keep the contract's `/` form.
 * @param {string} idPrefix
 * @param {string} logicalId
 * @param {string} phase
 * @returns {string}
 */
declare function physicalId(idPrefix: string, logicalId: string, phase: string): string;
/**
 * Fold dcPlan rows into the current plan per logical id (last row per node
 * wins — replans append superseding rows) plus the version count.
 * @param {Record<string, any>[]} planRows
 * @returns {Map<string, { plan: DcPlanRow; versions: number }>}
 */
declare function foldPlans(planRows: Record<string, any>[]): Map<string, {
    plan: DcPlanRow$1;
    versions: number;
}>;
/**
 * @typedef {{
 *   logicalId: string;
 *   parentId: string | null;
 *   tier: Tier;
 *   kind: "chunk" | "leaf";
 *   title: string;
 *   brief: string;
 *   estimate?: import("./delegationSchemas.ts").Estimate;
 * }} DelegationNodeInfo
 */
/**
 * Every node declared so far (each plan row's own node plus its children;
 * a child's own plan row supersedes the parent's declaration of it).
 * @param {Map<string, { plan: DcPlanRow; versions: number }>} plans
 * @returns {Map<string, DelegationNodeInfo>}
 */
declare function nodeIndex(plans: Map<string, {
    plan: DcPlanRow$1;
    versions: number;
}>): Map<string, DelegationNodeInfo$1>;
/**
 * Children declared as chunks that have no plan row of their own yet — the
 * next planning fan-out frontier.
 * @param {Map<string, { plan: DcPlanRow; versions: number }>} plans
 * @returns {DelegationNodeInfo[]}
 */
declare function unplannedChunks(plans: Map<string, {
    plan: DcPlanRow$1;
    versions: number;
}>): DelegationNodeInfo$1[];
/**
 * The current execution frontier: every child declared as a leaf (and not
 * superseded by its own plan row).
 * @param {Map<string, { plan: DcPlanRow; versions: number }>} plans
 * @returns {DelegationNodeInfo[]}
 */
declare function frontierLeaves(plans: Map<string, {
    plan: DcPlanRow$1;
    versions: number;
}>): DelegationNodeInfo$1[];
/**
 * Planning is complete when a root plan exists and every declared chunk has
 * produced its own plan row (the frontier is all leaves).
 * @param {Map<string, { plan: DcPlanRow; versions: number }>} plans
 * @returns {boolean}
 */
declare function planningComplete(plans: Map<string, {
    plan: DcPlanRow$1;
    versions: number;
}>): boolean;
/**
 * Latest dcGates row per logical id.
 * @param {Record<string, any>[]} gatesRows
 * @returns {Map<string, DcGatesRow>}
 */
declare function foldGates(gatesRows: Record<string, any>[]): Map<string, DcGatesRow$1>;
/**
 * Transitive dependents of a node: everything reachable by walking child
 * edges down from it plus reverse `depsLogical` edges (invalidation cascades
 * along BOTH — see the simulation's calibration delta #3). Excludes the node.
 * @param {string} logicalId
 * @param {Map<string, { plan: DcPlanRow; versions: number }>} plans
 * @param {Map<string, DcGatesRow>} gates
 * @returns {string[]}
 */
declare function dependentsOf(logicalId: string, plans: Map<string, {
    plan: DcPlanRow$1;
    versions: number;
}>, gates: Map<string, DcGatesRow$1>): string[];
/**
 * Map a logical id to the nearest ancestor-or-self that owns a plan row (the
 * delegating node responsible for replanning it). Leaves map to their parent.
 * @param {string} logicalId
 * @param {Map<string, { plan: DcPlanRow; versions: number }>} plans
 * @returns {string | null}
 */
declare function planOwnerOf(logicalId: string, plans: Map<string, {
    plan: DcPlanRow$1;
    versions: number;
}>): string | null;
/**
 * All frontier leaves at or under a logical id (a chunk-level dependency
 * expands to every leaf beneath it).
 * @param {string} logicalId
 * @param {Map<string, { plan: DcPlanRow; versions: number }>} plans
 * @returns {DelegationNodeInfo[]}
 */
declare function leavesUnder(logicalId: string, plans: Map<string, {
    plan: DcPlanRow$1;
    versions: number;
}>): DelegationNodeInfo$1[];
/**
 * Deterministic probe id for a plan risk.
 * @param {string} parentLogicalId
 * @param {string} riskId
 * @returns {string}
 */
declare function probeIdFor(parentLogicalId: string, riskId: string): string;
/**
 * Risks across the current plans that request a probe.
 * @param {Map<string, { plan: DcPlanRow; versions: number }>} plans
 * @returns {Array<{ parentLogicalId: string; probeId: string; kind: "poc" | "research"; risk: DcPlanRow["risks"][number] }>}
 */
declare function probesRequested(plans: Map<string, {
    plan: DcPlanRow$1;
    versions: number;
}>): Array<{
    parentLogicalId: string;
    probeId: string;
    kind: "poc" | "research";
    risk: DcPlanRow$1["risks"][number];
}>;
/**
 * @typedef {{ type: "probe" | "user-edit" | "review-fail"; ref: string; flagged: string; detail: Record<string, any> }} DeriskTrigger
 */
/**
 * Unaddressed replan triggers: probe findings whose planImpact is "changes",
 * live user edits, and chunk-level gate failures (from `chunkGateFailures`),
 * minus anything a dcReplan row already answered (matched by trigger.ref).
 * @param {Record<string, any>[]} probeRows
 * @param {Record<string, any>[]} editRows
 * @param {Record<string, any>[]} replanRows
 * @param {ChunkGateFailure[]} [chunkFailures]
 * @returns {DeriskTrigger[]}
 */
declare function pendingTriggers(probeRows: Record<string, any>[], editRows: Record<string, any>[], replanRows: Record<string, any>[], chunkFailures?: ChunkGateFailure[]): DeriskTrigger$1[];
/**
 * Map a trigger's flagged id onto the plan tree. Two flagged ids are not plan
 * nodes and would otherwise be silently swallowed by `planOwnerOf`:
 * - a probe logical id (`<parent>#<risk>`) — a live edit on a probe's output
 *   replans the probe's PARENT (the planning node that owns the risk);
 * - the goal node (`"goal"`) — an edit to the approved goal after planning
 *   started re-opens ROOT planning (the root plan is the goal's direct
 *   consumer), unless a caller really planned a node named "goal".
 * @param {string} flagged
 * @param {Map<string, { plan: DcPlanRow; versions: number }>} plans
 * @returns {string}
 */
declare function triggerTargetOf(flagged: string, plans: Map<string, {
    plan: DcPlanRow$1;
    versions: number;
}>): string;
/**
 * How many replan decisions a node has already made (its per-node round counter).
 * @param {Record<string, any>[]} replanRows
 * @param {string} logicalId
 * @returns {number}
 */
declare function replanCountFor(replanRows: Record<string, any>[], logicalId: string): number;
/**
 * Sum best-effort actuals across dcExec rows.
 * @param {Record<string, any>[]} execRows
 * @returns {{ tokens: number; costUsd: number; minutes: number }}
 */
declare function actualTotals(execRows: Record<string, any>[]): {
    tokens: number;
    costUsd: number;
    minutes: number;
};
/**
 * Split a dcGates row into ordered gate lists. Approval gates are only kept
 * when an approval policy was provided (contract: approval gates exist ONLY
 * under an approvalPolicy).
 * @param {DcGatesRow | undefined} gatesRow
 * @param {string | undefined} approvalPolicy
 */
declare function splitGates(gatesRow: DcGatesRow$1 | undefined, approvalPolicy: string | undefined): {
    reviews: {
        method: "review";
        tier: "fable" | "opus" | "sonnet" | "haiku";
        brief: string;
    }[];
    checks: {
        method: "check";
        command: string;
    }[];
    approvals: {
        method: "approval";
        policyMatch: string;
    }[];
    previews: {
        method: "preview";
        kind: "app" | "terminal" | "api" | "throwaway-ui" | "slideshow";
        brief: string;
    }[];
};
/**
 * Physical node id for a node's i-th developer-preview gate
 * (`dev-preview`, then `dev-preview-2`, ...).
 * @param {string} idPrefix
 * @param {string} logicalId
 * @param {number} index zero-based gate index
 * @returns {string}
 */
declare function devPreviewNodeId(idPrefix: string, logicalId: string, index: number): string;
/**
 * Attempt-state of one leaf, derived from dcExec/dcReview rows: the attempt
 * loop's `until` condition, the verdict feedback folded into retries, and the
 * attempt number surfaced in prompts. Gate rows are matched by physical node
 * id + loop iteration, so agent-reported `attempt` fields never gate control
 * flow.
 * @param {{
 *   execRows: Record<string, any>[];
 *   reviewRows: Record<string, any>[];
 *   execId: string;
 *   gateNodeIds: string[];
 *   devPreviewRows?: Record<string, any>[];
 *   previewNodeIds?: string[];
 * }} opts
 */
declare function leafAttemptState(opts: {
    execRows: Record<string, any>[];
    reviewRows: Record<string, any>[];
    execId: string;
    gateNodeIds: string[];
    devPreviewRows?: Record<string, any>[];
    previewNodeIds?: string[];
}): {
    attempts: number;
    latestIteration: number;
    allPass: boolean;
    failedFeedback: string[];
};
/**
 * Whether one leaf is fully complete: latest attempt's exec + every declared
 * review/check gate passed, and (under an approvalPolicy) every approval gate
 * approved.
 * @param {{
 *   idPrefix: string;
 *   leaf: DelegationNodeInfo;
 *   gates: Map<string, DcGatesRow>;
 *   approvalPolicy: string | undefined;
 *   execRows: Record<string, any>[];
 *   reviewRows: Record<string, any>[];
 *   approvalRows: Record<string, any>[];
 *   devPreviewRows?: Record<string, any>[];
 * }} opts
 * @returns {boolean}
 */
declare function leafComplete(opts: {
    idPrefix: string;
    leaf: DelegationNodeInfo$1;
    gates: Map<string, DcGatesRow$1>;
    approvalPolicy: string | undefined;
    execRows: Record<string, any>[];
    reviewRows: Record<string, any>[];
    approvalRows: Record<string, any>[];
    devPreviewRows?: Record<string, any>[];
}): boolean;
/**
 * @typedef {{ logicalId: string; gateNodeId: string; ref: string; feedback: string }} ChunkGateFailure
 */
/**
 * Chunk-level review-gate failures: for every planning (non-leaf) node with
 * declared review gates, the gate nodes whose LATEST dcReview verdict is
 * "fail" (a subsequent pass supersedes it). Leaf gate failures are handled by
 * the leaf's own attempt loop (`leafAttemptState`); chunk reviews have no
 * attempt loop, so a fail must become a derisk/replan trigger instead — each
 * failure carries a deterministic `ref` (`<gateNodeId>#fail-<rowCount>`) that
 * a dcReplan row addresses via `trigger.ref`, and a NEW failure after more
 * rows re-triggers with a fresh ref.
 * @param {{
 *   idPrefix: string;
 *   plans: Map<string, { plan: DcPlanRow; versions: number }>;
 *   gates: Map<string, DcGatesRow>;
 *   approvalPolicy: string | undefined;
 *   reviewRows: Record<string, any>[];
 * }} opts
 * @returns {ChunkGateFailure[]}
 */
declare function chunkGateFailures(opts: {
    idPrefix: string;
    plans: Map<string, {
        plan: DcPlanRow$1;
        versions: number;
    }>;
    gates: Map<string, DcGatesRow$1>;
    approvalPolicy: string | undefined;
    reviewRows: Record<string, any>[];
}): ChunkGateFailure[];
/**
 * Whether the whole execution phase is complete: planning done, a non-empty
 * leaf frontier, every leaf complete, and no chunk-level review gate stuck on
 * a latest-fail — a chunk fail must be superseded by a later pass or answered
 * by a dcReplan row (matched on `trigger.ref`) before scoring may start.
 * @param {{
 *   idPrefix: string;
 *   plans: Map<string, { plan: DcPlanRow; versions: number }>;
 *   gates: Map<string, DcGatesRow>;
 *   approvalPolicy: string | undefined;
 *   execRows: Record<string, any>[];
 *   reviewRows: Record<string, any>[];
 *   approvalRows: Record<string, any>[];
 *   devPreviewRows?: Record<string, any>[];
 *   replanRows?: Record<string, any>[];
 *   maxDeriskRounds?: number;
 * }} opts
 * @returns {boolean}
 */
declare function executionComplete(opts: {
    idPrefix: string;
    plans: Map<string, {
        plan: DcPlanRow$1;
        versions: number;
    }>;
    gates: Map<string, DcGatesRow$1>;
    approvalPolicy: string | undefined;
    execRows: Record<string, any>[];
    reviewRows: Record<string, any>[];
    approvalRows: Record<string, any>[];
    devPreviewRows?: Record<string, any>[];
    replanRows?: Record<string, any>[];
    maxDeriskRounds?: number;
}): boolean;
/**
 * Resolve a tier label to an agent from the `agents` prop, walking down the
 * tier order for the nearest configured fallback.
 * @param {Partial<Record<Tier, AgentLike | AgentLike[]>>} agents
 * @param {Tier} tier
 * @param {readonly Tier[]} [tierOrder]
 * @returns {AgentLike | AgentLike[] | undefined}
 */
declare function agentForTier(agents: Partial<Record<Tier$2, AgentLike$1 | AgentLike$1[]>>, tier: Tier$2, tierOrder?: readonly Tier$2[]): AgentLike$1 | AgentLike$1[] | undefined;
/**
 * Synthesize the delegation event log the run scorers in
 * `smthrs/scorers` fold (`DelegationEvent[]` — the simulation
 * contract's vocabulary) from the dc* rows the run actually wrote. Output
 * rows carry no cross-table timestamps, so events are emitted in phase order
 * with one documented approximation: probe/user-edit replans are treated as
 * plan-phase (the derisk loop runs before execution), while review-fail
 * replans are post-exec by construction (chunk reviews only run after their
 * subtree executed) and are emitted after the execution events.
 *
 * Mapping (dc row → event `t`):
 * - dcPlan.risks[*]                        → RISK_FLAGGED { node, risk }
 * - dcPlan.risks[*] with probe poc/research → PROBE_SPAWNED { parent, probe: "<parent>#<risk>", kind }
 * - dcProbe                                → FINDING_REPORTED { probe, toParent, planImpact }
 * - dcReplan                               → REPLAN_REQUESTED { from, reason, trigger } then
 *                                            NODE_INVALIDATED | NODE_REAFFIRMED { node }
 * - dcExec first row per logicalId         → EXEC_STARTED { node }
 * - dcExec subsequent rows (retries)       → REDELEGATED { node }
 * - dcReview                               → GATE_FAILED | GATE_PASSED { node }
 * - dcDevPreview with builtOk !== true     → GATE_FAILED { node, gate: "preview" }
 * - every executed node, at the end        → NODE_DONE { node }
 *
 * @param {{
 *   planRows: Record<string, any>[];
 *   probeRows: Record<string, any>[];
 *   replanRows: Record<string, any>[];
 *   execRows: Record<string, any>[];
 *   reviewRows: Record<string, any>[];
 *   devPreviewRows?: Record<string, any>[];
 * }} opts
 * @returns {Record<string, any>[]}
 */
declare function synthesizeDelegationEvents(opts: {
    planRows: Record<string, any>[];
    probeRows: Record<string, any>[];
    replanRows: Record<string, any>[];
    execRows: Record<string, any>[];
    reviewRows: Record<string, any>[];
    devPreviewRows?: Record<string, any>[];
}): Record<string, any>[];
type AgentLike$1 = _smthrs_agents_AgentLike.AgentLike;
type DelegationNodeInfo$1 = {
    logicalId: string;
    parentId: string | null;
    tier: Tier$2;
    kind: "chunk" | "leaf";
    title: string;
    brief: string;
    estimate?: Estimate$1;
};
type DeriskTrigger$1 = {
    type: "probe" | "user-edit" | "review-fail";
    ref: string;
    flagged: string;
    detail: Record<string, any>;
};
type ChunkGateFailure = {
    logicalId: string;
    gateNodeId: string;
    ref: string;
    feedback: string;
};
type DcGatesRow$1 = DcGatesRow$2;
type DcPlanRow$1 = DcPlanRow$2;
type Tier$2 = Tier$3;

/**
 * <DeriskLoop> — risk hunting + replan cascades (frames 5-7).
 *
 * Reactive rounds instead of a `<Loop>` primitive (each round's tasks carry
 * explicit round numbers, so ids stay stable and replay-friendly):
 *
 * 1. Every risk with `probe != null` in a CURRENT plan spawns a probe task
 *    (haiku research / sonnet poc) reporting to its nearest parent only.
 * 2. Probe findings with `planImpact: "changes"`, delivered `dc-edit`
 *    signal rows, and chunk-level review-gate failures (trigger type
 *    "review-fail") are triggers. Edits on probe outputs (`<parent>#<risk>`)
 *    map to the probe's parent; post-approval goal edits map to the root.
 *    Affected = the flagged node + its dependents (child AND dep edges),
 *    each mapped to its plan-owning ancestor.
 * 3. Each affected owner gets a replan-decision task
 *    (`<p>:<id>:replan-<k>`, k = its per-node round counter); an
 *    `invalidated` decision mounts a fresh plan task (`<p>:<id>:plan-<k>`)
 *    whose row supersedes the old version. Rounds stop at `maxDeriskRounds`
 *    per node.
 * @param {DeriskLoopProps} props
 */
declare function DeriskLoop(props: DeriskLoopProps$1): React__default.FunctionComponentElement<SequenceProps$2> | null;
type DeriskLoopProps$1 = DeriskLoopProps$2;

/**
 * <DelegationExecution> — walk the leaf frontier with max parallelism
 * (frames 8-9).
 *
 * Per leaf: a `<Loop>` (iteration = attempt) of exec Task then its declared
 * gates — review gates at their declared tier, check gates as lean
 * command-runner tasks, both writing dcReview rows and `dependsOn` the exec
 * node. A failed gate loops with the verdict folded into the next attempt's
 * brief. Approval gates (only under an approvalPolicy) materialize as
 * `<Approval>` after the loop passes. Cross-leaf ordering comes from dcGates
 * `depsLogical`: a leaf's pipeline only MOUNTS once every leaf under each of
 * its logical deps is complete (render-gating — strictly stronger than a
 * dependsOn edge, and safe across loop scopes).
 *
 * Node ids: `<p>:<leaf>:exec`, `<p>:<leaf>:review-<i>` (reviews then checks),
 * `<p>:<leaf>:approval-<i>`, `<p>:<leaf>:budget` (internal guard).
 * @param {DelegationExecutionProps} props
 */
declare function DelegationExecution(props: DelegationExecutionProps$1): React__default.FunctionComponentElement<SequenceProps$2> | null;
type DelegationExecutionProps$1 = DelegationExecutionProps$2;

/**
 * <DelegationScoring> — end-of-run scoring + human poll (frame 10).
 *
 * Per-task scorers ride the exec/review tasks inside DelegationExecution
 * (`scorers.exec` / `scorers.review`); this composite adds the run level.
 * When `poll` is enabled, the 3-question satisfaction poll HumanTask
 * (`<p>:root:poll`) mounts FIRST — the run's final attention badge — and the
 * run-score task (`<p>:root:score`) mounts only after the poll row lands, so
 * `humanPollScorer` sees the submitted poll instead of always skipping.
 *
 * The score task carries the caller's `scorers.run` (e.g. built from
 * `delegationRunScore` in `smthrs/scorers`) and a `context`
 * synthesized to the exact shapes those scorers parse:
 * - `events` + `nodes` — a faithful DelegationEvent[] log derived from the
 *   dc* rows (see `synthesizeDelegationEvents`) for pocJudgment/planSolidity;
 * - `plan` + `exec` — the raw dcPlan/dcExec rows for estimateAccuracy;
 * - `poll` — the poll's `{ question, answer }` entries for humanPoll;
 * - `tier`/`brief`/`stats` — the root node descriptor for tierFit.
 * @param {DelegationScoringProps} props
 */
declare function DelegationScoring(props: DelegationScoringProps$1): React__default.FunctionComponentElement<SequenceProps$2> | null;
type DelegationScoringProps$1 = DelegationScoringProps$2;

/**
 * <DelegationEditListener> — the live-edit branch (frame 7).
 *
 * A `<Loop>` re-arming a durable `dc-edit` signal wait: every delivered edit
 * writes a dcEdit row (`{ editId, logicalId, editedOutput, note? }` from the
 * UI's WYSIWYG editors) which DeriskLoop picks up as a replan trigger — user
 * edits ride the same invalidation path as probe findings. Renders in a
 * `<Parallel>` branch beside the phase sequence; the loop's `until` flips
 * once the run is effectively done (poll answered, or execution complete with
 * the poll disabled), unmounting the armed wait so the run can finish.
 * @param {DelegationEditListenerProps} props
 */
declare function DelegationEditListener(props: DelegationEditListenerProps$1): React__default.FunctionComponentElement<LoopProps$2> | null;
type DelegationEditListenerProps$1 = DelegationEditListenerProps$2;

/** @typedef {import("./delegationSchemas.ts").Tier} Tier */
/** @typedef {import("./delegationState.js").DelegationNodeInfo} DelegationNodeInfo */
/** @typedef {import("./delegationState.js").DeriskTrigger} DeriskTrigger */
/**
 * Prompt templates for every delegation-chain tier/phase. Prompt text lives IN
 * this package (seeded workflow packs cannot import `.smithers/prompts`).
 *
 * Delegating-tier prompts (plan/replan/backpressure/review/goal) embed the
 * distilled context-engineering principles; leaf (sonnet) and probe (haiku)
 * prompts stay lean task briefs.
 */
/**
 * The distilled context-engineering principles every DELEGATING-tier prompt
 * carries (condensed from the layered model: prompt → context → harness →
 * workflow → backpressure).
 * @returns {string}
 */
declare function contextPrinciples(): string;
/**
 * Fable/opus goal-refinement question forecast.
 * @param {{ prompt: string; maxQuestions: number; approvalPolicy?: string }} opts
 * @returns {string}
 */
declare function goalQuestionsPrompt(opts: {
    prompt: string;
    maxQuestions: number;
    approvalPolicy?: string;
}): string;
/**
 * Haiku form-metadata render for one forecast question (lean brief).
 * @param {{ question: Record<string, any> }} opts
 * @returns {string}
 */
declare function questionFormPrompt(opts: {
    question: Record<string, any>;
}): string;
/**
 * Fable goal refinement after all questions are answered.
 * @param {{ prompt: string; qa: Array<{ question: string; answer: string }>; approvalPolicy?: string }} opts
 * @returns {string}
 */
declare function goalRefinePrompt(opts: {
    prompt: string;
    qa: Array<{
        question: string;
        answer: string;
    }>;
    approvalPolicy?: string;
}): string;
/**
 * The refined-prompt approval form shown to the human.
 * @param {{ goal: Record<string, any> }} opts
 * @returns {string}
 */
declare function goalApprovalPrompt(opts: {
    goal: Record<string, any>;
}): string;
/**
 * Delegating-tier decomposition prompt (also used for replan-generated new
 * plan versions via `replan`).
 * @param {{
 *   logicalId: string;
 *   tier: Tier;
 *   brief: string;
 *   parent?: { logicalId: string; title: string } | undefined;
 *   depth: number;
 *   maxDepth: number;
 *   tierOrder: readonly Tier[];
 *   approvalPolicy?: string | undefined;
 *   replan?: { round: number; reason: string; triggerRef: string } | undefined;
 * }} opts
 * @returns {string}
 */
declare function planPrompt(opts: {
    logicalId: string;
    tier: Tier$1;
    brief: string;
    parent?: {
        logicalId: string;
        title: string;
    } | undefined;
    depth: number;
    maxDepth: number;
    tierOrder: readonly Tier$1[];
    approvalPolicy?: string | undefined;
    replan?: {
        round: number;
        reason: string;
        triggerRef: string;
    } | undefined;
}): string;
/**
 * Haiku zero-backpressure preview of a leaf's expected output (lean brief).
 * @param {{ leaf: DelegationNodeInfo }} opts
 * @returns {string}
 */
declare function previewPrompt(opts: {
    leaf: DelegationNodeInfo;
}): string;
/**
 * Delegating-tier backpressure declaration for one node.
 * @param {{
 *   node: DelegationNodeInfo;
 *   knownNodeIds: string[];
 *   approvalPolicy?: string | undefined;
 * }} opts
 * @returns {string}
 */
declare function gatesPrompt(opts: {
    node: DelegationNodeInfo;
    knownNodeIds: string[];
    approvalPolicy?: string | undefined;
}): string;
/**
 * Probe task brief (lean — haiku research / sonnet poc).
 * @param {{
 *   parentLogicalId: string;
 *   probeId: string;
 *   kind: "poc" | "research";
 *   risk: { id: string; description: string; reason: string };
 *   parentBrief: string;
 * }} opts
 * @returns {string}
 */
declare function probePrompt(opts: {
    parentLogicalId: string;
    probeId: string;
    kind: "poc" | "research";
    risk: {
        id: string;
        description: string;
        reason: string;
    };
    parentBrief: string;
}): string;
/**
 * Delegating-tier replan decision for one affected node.
 * @param {{
 *   logicalId: string;
 *   round: number;
 *   plan: Record<string, any> | undefined;
 *   brief: string;
 *   triggers: DeriskTrigger[];
 *   approvalPolicy?: string | undefined;
 * }} opts
 * @returns {string}
 */
declare function replanPrompt(opts: {
    logicalId: string;
    round: number;
    plan: Record<string, any> | undefined;
    brief: string;
    triggers: DeriskTrigger[];
    approvalPolicy?: string | undefined;
}): string;
/**
 * Leaf executor brief (lean, sonnet-tier).
 * @param {{
 *   leaf: DelegationNodeInfo;
 *   gates: import("./delegationSchemas.ts").Gate[];
 *   attempt: number;
 *   feedback: string[];
 * }} opts
 * @returns {string}
 */
declare function execPrompt(opts: {
    leaf: DelegationNodeInfo;
    gates: Gate$1[];
    attempt: number;
    feedback: string[];
}): string;
/**
 * Review-gate prompt (delegating tier — strict). The reviewer receives the
 * reviewed node's structured output and its commit range(s), and inspects the
 * commits itself.
 * @param {{
 *   leaf: DelegationNodeInfo;
 *   gate: { method: "review"; tier: Tier; brief: string };
 *   attempt: number;
 *   execOutput: Record<string, any> | undefined;
 *   commitRanges: Array<{ from: string; to: string; vcs: "jj" | "git" }>;
 * }} opts
 * @returns {string}
 */
declare function reviewPrompt(opts: {
    leaf: DelegationNodeInfo;
    gate: {
        method: "review";
        tier: Tier$1;
        brief: string;
    };
    attempt: number;
    execOutput: Record<string, any> | undefined;
    commitRanges: Array<{
        from: string;
        to: string;
        vcs: "jj" | "git";
    }>;
}): string;
/**
 * Chunk-level review-gate prompt: reviews a planning node's whole completed
 * subtree against the union of its leaves' commit ranges.
 * @param {{
 *   node: DelegationNodeInfo;
 *   gate: { method: "review"; tier: Tier; brief: string };
 *   execOutputs: Array<Record<string, any>>;
 *   commitRanges: Array<{ from: string; to: string; vcs: "jj" | "git" }>;
 * }} opts
 * @returns {string}
 */
declare function chunkReviewPrompt(opts: {
    node: DelegationNodeInfo;
    gate: {
        method: "review";
        tier: Tier$1;
        brief: string;
    };
    execOutputs: Array<Record<string, any>>;
    commitRanges: Array<{
        from: string;
        to: string;
        vcs: "jj" | "git";
    }>;
}): string;
/**
 * Check-gate prompt (lean — run one command, report the verdict).
 * @param {{
 *   leaf: DelegationNodeInfo;
 *   gate: { method: "check"; command: string };
 *   attempt: number;
 * }} opts
 * @returns {string}
 */
declare function checkPrompt(opts: {
    leaf: DelegationNodeInfo;
    gate: {
        method: "check";
        command: string;
    };
    attempt: number;
}): string;
/**
 * Developer-preview gate task (haiku/sonnet-tier, lean): build the showable
 * artifact for a node after its execution.
 * @param {{
 *   logicalId: string;
 *   title: string;
 *   gate: { method: "preview"; kind: import("./delegationSchemas.ts").DevPreviewKind; brief: string };
 *   attempt: number;
 *   execSummaries: string[];
 *   feedback: string[];
 * }} opts
 * @returns {string}
 */
declare function devPreviewPrompt(opts: {
    logicalId: string;
    title: string;
    gate: {
        method: "preview";
        kind: DevPreviewKind$1;
        brief: string;
    };
    attempt: number;
    execSummaries: string[];
    feedback: string[];
}): string;
/**
 * End-of-run satisfaction poll form.
 * @returns {string}
 */
declare function pollPrompt(): string;
/**
 * Answer form prompt for one question (shown by the durable human request;
 * the UI renders the dcQuestion row's form metadata alongside).
 * @param {{ question: Record<string, any> }} opts
 * @returns {string}
 */
declare function answerPrompt(opts: {
    question: Record<string, any>;
}): string;
type Tier$1 = Tier$3;
type DelegationNodeInfo = DelegationNodeInfo$1;
type DeriskTrigger = DeriskTrigger$1;

type delegationPrompts_DelegationNodeInfo = DelegationNodeInfo;
type delegationPrompts_DeriskTrigger = DeriskTrigger;
declare const delegationPrompts_answerPrompt: typeof answerPrompt;
declare const delegationPrompts_checkPrompt: typeof checkPrompt;
declare const delegationPrompts_chunkReviewPrompt: typeof chunkReviewPrompt;
declare const delegationPrompts_contextPrinciples: typeof contextPrinciples;
declare const delegationPrompts_devPreviewPrompt: typeof devPreviewPrompt;
declare const delegationPrompts_execPrompt: typeof execPrompt;
declare const delegationPrompts_gatesPrompt: typeof gatesPrompt;
declare const delegationPrompts_goalApprovalPrompt: typeof goalApprovalPrompt;
declare const delegationPrompts_goalQuestionsPrompt: typeof goalQuestionsPrompt;
declare const delegationPrompts_goalRefinePrompt: typeof goalRefinePrompt;
declare const delegationPrompts_planPrompt: typeof planPrompt;
declare const delegationPrompts_pollPrompt: typeof pollPrompt;
declare const delegationPrompts_previewPrompt: typeof previewPrompt;
declare const delegationPrompts_probePrompt: typeof probePrompt;
declare const delegationPrompts_questionFormPrompt: typeof questionFormPrompt;
declare const delegationPrompts_replanPrompt: typeof replanPrompt;
declare const delegationPrompts_reviewPrompt: typeof reviewPrompt;
declare namespace delegationPrompts {
  export { type delegationPrompts_DelegationNodeInfo as DelegationNodeInfo, type delegationPrompts_DeriskTrigger as DeriskTrigger, type Tier$1 as Tier, delegationPrompts_answerPrompt as answerPrompt, delegationPrompts_checkPrompt as checkPrompt, delegationPrompts_chunkReviewPrompt as chunkReviewPrompt, delegationPrompts_contextPrinciples as contextPrinciples, delegationPrompts_devPreviewPrompt as devPreviewPrompt, delegationPrompts_execPrompt as execPrompt, delegationPrompts_gatesPrompt as gatesPrompt, delegationPrompts_goalApprovalPrompt as goalApprovalPrompt, delegationPrompts_goalQuestionsPrompt as goalQuestionsPrompt, delegationPrompts_goalRefinePrompt as goalRefinePrompt, delegationPrompts_planPrompt as planPrompt, delegationPrompts_pollPrompt as pollPrompt, delegationPrompts_previewPrompt as previewPrompt, delegationPrompts_probePrompt as probePrompt, delegationPrompts_questionFormPrompt as questionFormPrompt, delegationPrompts_replanPrompt as replanPrompt, delegationPrompts_reviewPrompt as reviewPrompt };
}

/** @param {Record<string, any>} assignment */
declare function delegationV2AssignmentDigest(assignment: Record<string, any>): string;
/**
 * @param {{
 *   envelope?: Record<string, any>,
 *   assignment: Record<string, any>,
 *   identity: Record<string, any>,
 *   taskFailure?: {code: "crash"|"timeout"|"invalid_return"|"cancelled"|"budget_exhausted"|"invalid_subworkflow", message: string},
 * }} options
 */
declare function settleDelegationV2Envelope({ envelope, assignment, identity, taskFailure }: {
    envelope?: Record<string, any>;
    assignment: Record<string, any>;
    identity: Record<string, any>;
    taskFailure?: {
        code: "crash" | "timeout" | "invalid_return" | "cancelled" | "budget_exhausted" | "invalid_subworkflow";
        message: string;
    };
}): {
    invocationKey: string;
    logicalId: string;
    generation: number;
    role: "fable" | "sol" | "terra" | "luna";
    work: "synthesize" | "plan" | "review" | "preview" | "poc" | "research" | "refine_goal" | "execute";
    outputContract: "plan" | "goal_contract" | "work_product" | "evidence_collection" | "issue_scan" | "classification" | "condition" | "evaluation" | "artifact_collection";
    assignmentDigest: string;
    acceptanceCriterionIds: string[];
    status: "complete" | "blocked" | "runtime_failed";
    sourceNodeId: string;
    programDigest?: string | undefined;
    product?: {
        [x: string]: any;
        summary: string;
        acceptance: {
            criterionId: string;
            status: "unknown" | "passed" | "failed";
            evidenceIds: string[];
            explanation: string;
        }[];
        evidence: {
            id: string;
            kind: "source" | "artifact" | "observation" | "test" | "analysis" | "user_input";
            summary: string;
            locator?: string | undefined;
        }[];
        artifacts: {
            id: string;
            kind: "file" | "preview" | "url" | "report" | "diff" | "command_output" | "other";
            locator: string;
            summary: string;
        }[];
        assumptions: string[];
        openRisks: {
            risk: string;
            impact: string;
            mitigation?: string | undefined;
        }[];
        work: any;
    } | undefined;
    blockage?: {
        summary: string;
        partialWork: string;
        attemptedAlternatives: string[];
        whyNoSafeFallbackExists: string;
        requiredNextAction: string;
        evidence: {
            id: string;
            kind: "source" | "artifact" | "observation" | "test" | "analysis" | "user_input";
            summary: string;
            locator?: string | undefined;
        }[];
        openRisks: {
            risk: string;
            impact: string;
            mitigation?: string | undefined;
        }[];
        work: "synthesize" | "plan" | "review" | "preview" | "poc" | "research" | "refine_goal" | "execute";
    } | undefined;
    runtimeFailure?: {
        code: "cancelled" | "crash" | "timeout" | "invalid_return" | "budget_exhausted" | "invalid_subworkflow";
        message: string;
    } | undefined;
};
declare const DELEGATION_V2_RUNTIME_VERSION: "delegation-v2.runtime-7";
declare const DELEGATION_V2_SETTLEMENT_VERSION: "delegation-v2.settlement-2";

/**
 * Dynamic, append-only, model-authored delegation over a closed IR registry.
 * @param {TrellisProps} props
 */
declare function Trellis(props: TrellisProps$1): React__default.FunctionComponentElement<SequenceProps$2> | null;

type TrellisProps$1 = TrellisProps$2;

/**
 * Render prompt layers 1-3: immutable protocol, trusted runtime authority, and
 * the role overlay. Work and assignment layers are added by turn builders.
 * @param {{ authority: DelegationV2Authority }} opts
 */
declare function renderDelegationV2SystemPrompt({ authority }: {
    authority: DelegationV2Authority;
}): string;
/**
 * Render exactly one work-kind playbook.
 * @param {string} work
 */
declare function renderWorkKindPlaybook(work: string): string;
/**
 * Render a compact, JSON-escaped pattern reference. Callers may pass a trusted
 * registry slice; omitting it renders the Phase A core.
 * @param {ReadonlyArray<Record<string, unknown> | string>} [patterns]
 */
declare function renderPatternIndexPrompt(patterns?: ReadonlyArray<Record<string, unknown> | string>): string;
/**
 * @param {{ authority: DelegationV2Authority; goal: unknown; instructions?: unknown; evidence?: unknown }} opts
 */
declare function renderInitialAuthorPrompt({ authority, goal, instructions, evidence }: {
    authority: DelegationV2Authority;
    goal: unknown;
    instructions?: unknown;
    evidence?: unknown;
}): string;
/**
 * @param {{ authority: DelegationV2Authority; goal: unknown; instructions?: unknown; evidence?: unknown; previousState: unknown; acceptedProgramRefs?: unknown }} opts
 */
declare function renderContinuationAuthorPrompt({ authority, goal, instructions, evidence, previousState, acceptedProgramRefs, }: {
    authority: DelegationV2Authority;
    goal: unknown;
    instructions?: unknown;
    evidence?: unknown;
    previousState: unknown;
    acceptedProgramRefs?: unknown;
}): string;
/**
 * Semantic IR repair is intentionally separate from output-format repair. An
 * empty Task allowlist records runtime intent, but Phase A does not pretend it
 * removes ambient shell/tool capabilities from every agent adapter.
 * @param {{ authority: DelegationV2Authority; goal: unknown; diagnostics: unknown; rejectedProgram: unknown; requiredSupersedes: unknown }} opts
 */
declare function renderRepairAuthorPrompt({ authority, goal, diagnostics, rejectedProgram, requiredSupersedes }: {
    authority: DelegationV2Authority;
    goal: unknown;
    diagnostics: unknown;
    rejectedProgram: unknown;
    requiredSupersedes: unknown;
}): string;
/**
 * @param {{ authority: DelegationV2Authority; goal: unknown; instructions?: unknown; evidence?: unknown }} opts
 */
declare function renderWorkerPrompt({ authority, goal, instructions, evidence }: {
    authority: DelegationV2Authority;
    goal: unknown;
    instructions?: unknown;
    evidence?: unknown;
}): string;
/**
 * Prompt contract for Dynamic Delegation v2.
 *
 * These builders deliberately accept only data and return plain strings. The
 * runtime is still responsible for enforcing schemas, tools, sandboxes, and
 * fuel; prompt text is never treated as a capability boundary.
 */
declare const DELEGATION_V2_PROMPT_CONTRACT_VERSION: "delegation-v2.prompt/3";
declare const DELEGATION_V2_PROTOCOL_VERSION$1: 2;
declare const DELEGATION_V2_PLAYBOOK_VERSION: "delegation-v2.playbooks/1";
declare const DELEGATION_V2_PATTERN_INDEX_VERSION: "delegation-v2.patterns/1";
/**
 * Compact, data-only guidance for the Phase A primitive registry. Pattern
 * names have no execution semantics; accepted normalized IR does.
 */
declare const CORE_PATTERN_INDEX: readonly (Readonly<{
    id: "direct";
    purpose: "Give one closed goal to one lowest-capable agent.";
    shape: "agent";
    useWhen: "One evidence contract can prove the result.";
    avoidWhen: "The goal still contains independent unknowns.";
    outputs: "one declared agent output";
    cost: "lowest";
    concurrency: "one slot";
}> | Readonly<{
    id: "pipeline";
    purpose: "Pass settled evidence through ordered stages.";
    shape: "sequence(agent, ...)";
    useWhen: "A later stage genuinely consumes an earlier result.";
    avoidWhen: "Stages are independent or purely ceremonial.";
    outputs: "explicit final-stage refs";
    cost: "linear";
    concurrency: "serial";
}> | Readonly<{
    id: "fan_out_fan_in";
    purpose: "Gather independent evidence, then reconcile it.";
    shape: "sequence(parallel(agent, ...), synthesize-agent)";
    useWhen: "Independent perspectives or partitions reduce uncertainty.";
    avoidWhen: "Branches need one another or duplicate the same work.";
    outputs: "all branch refs plus one synthesis ref";
    cost: "one task per branch plus synthesis";
    concurrency: "bounded by the parallel and root caps";
}> | Readonly<{
    id: "panel_debate";
    purpose: "Expose real disagreement and select with an explicit judge.";
    shape: "sequence(parallel(position-agents), review-or-synthesize-agent)";
    useWhen: "Competing approaches have material, testable tradeoffs.";
    avoidWhen: "More opinions cannot change the decision.";
    outputs: "positions and a reasoned verdict";
    cost: "high";
    concurrency: "parallel positions, serial verdict";
}> | Readonly<{
    id: "derisk";
    purpose: "Test assumptions before committing to expensive action.";
    shape: "parallel(research-or-poc-agents) -> author continuation";
    useWhen: "A finding could invalidate the approach.";
    avoidWhen: "The fact is already established or cannot change the plan.";
    outputs: "decision-relevant evidence";
    cost: "variable; prefer the smallest decisive probe";
    concurrency: "independent probes only";
}> | Readonly<{
    id: "review_loop";
    purpose: "Inspect completed work and append only actionable corrections.";
    shape: "sequence(execute-agent, review-agent) -> author continuation";
    useWhen: "Independent judgment can materially improve the artifact.";
    avoidWhen: "A deterministic check fully proves the criterion.";
    outputs: "artifact and evidence-backed review";
    cost: "at least two tasks per round";
    concurrency: "serial; every extra round consumes generation fuel";
}> | Readonly<{
    id: "optimizer";
    purpose: "Improve an artifact against a measurable contract.";
    shape: "sequence(generate-agent, evaluation-agent) -> author continuation";
    useWhen: "Quality can be evaluated and another round can improve it.";
    avoidWhen: "There is no stable measure or stopping condition.";
    outputs: "candidate and criterion-level evaluation";
    cost: "potentially high";
    concurrency: "serial rounds; fuel-bounded";
}> | Readonly<{
    id: "supervisor";
    purpose: "Turn a broad goal into bounded work and reassess real results.";
    shape: "plan-agent -> worker fragment -> author continuation";
    useWhen: "Subtasks can be closed after targeted planning.";
    avoidWhen: "The author can already state one closed direct task.";
    outputs: "plan evidence and selected worker outputs";
    cost: "planning overhead plus workers";
    concurrency: "worker fan-out remains root-capped";
}>)[];
type DelegationV2Authority = {
    role: "sol" | "fable" | "terra" | "luna";
    work?: string | undefined;
    workKind?: string | undefined;
    questionToolAvailable: boolean;
    questionTargets?: string[] | undefined;
    allowedQuestionTargets?: string[] | undefined;
    canAuthorSubworkflow?: boolean | undefined;
    mayAuthorSubworkflow?: boolean | undefined;
    directExecutionAllowed?: boolean | undefined;
    criticalExecutionGrant?: unknown;
    criticalExecutionPolicy?: unknown;
    criticalReviewIndependentRoles?: {
        sol: string[];
        fable: string[];
    } | undefined;
    fuel?: unknown;
};

declare const delegationV2Prompts_CORE_PATTERN_INDEX: typeof CORE_PATTERN_INDEX;
declare const delegationV2Prompts_DELEGATION_V2_PATTERN_INDEX_VERSION: typeof DELEGATION_V2_PATTERN_INDEX_VERSION;
declare const delegationV2Prompts_DELEGATION_V2_PLAYBOOK_VERSION: typeof DELEGATION_V2_PLAYBOOK_VERSION;
declare const delegationV2Prompts_DELEGATION_V2_PROMPT_CONTRACT_VERSION: typeof DELEGATION_V2_PROMPT_CONTRACT_VERSION;
type delegationV2Prompts_DelegationV2Authority = DelegationV2Authority;
declare const delegationV2Prompts_renderContinuationAuthorPrompt: typeof renderContinuationAuthorPrompt;
declare const delegationV2Prompts_renderDelegationV2SystemPrompt: typeof renderDelegationV2SystemPrompt;
declare const delegationV2Prompts_renderInitialAuthorPrompt: typeof renderInitialAuthorPrompt;
declare const delegationV2Prompts_renderPatternIndexPrompt: typeof renderPatternIndexPrompt;
declare const delegationV2Prompts_renderRepairAuthorPrompt: typeof renderRepairAuthorPrompt;
declare const delegationV2Prompts_renderWorkKindPlaybook: typeof renderWorkKindPlaybook;
declare const delegationV2Prompts_renderWorkerPrompt: typeof renderWorkerPrompt;
declare namespace delegationV2Prompts {
  export { delegationV2Prompts_CORE_PATTERN_INDEX as CORE_PATTERN_INDEX, delegationV2Prompts_DELEGATION_V2_PATTERN_INDEX_VERSION as DELEGATION_V2_PATTERN_INDEX_VERSION, delegationV2Prompts_DELEGATION_V2_PLAYBOOK_VERSION as DELEGATION_V2_PLAYBOOK_VERSION, delegationV2Prompts_DELEGATION_V2_PROMPT_CONTRACT_VERSION as DELEGATION_V2_PROMPT_CONTRACT_VERSION, DELEGATION_V2_PROTOCOL_VERSION$1 as DELEGATION_V2_PROTOCOL_VERSION, type delegationV2Prompts_DelegationV2Authority as DelegationV2Authority, delegationV2Prompts_renderContinuationAuthorPrompt as renderContinuationAuthorPrompt, delegationV2Prompts_renderDelegationV2SystemPrompt as renderDelegationV2SystemPrompt, delegationV2Prompts_renderInitialAuthorPrompt as renderInitialAuthorPrompt, delegationV2Prompts_renderPatternIndexPrompt as renderPatternIndexPrompt, delegationV2Prompts_renderRepairAuthorPrompt as renderRepairAuthorPrompt, delegationV2Prompts_renderWorkKindPlaybook as renderWorkKindPlaybook, delegationV2Prompts_renderWorkerPrompt as renderWorkerPrompt };
}

/** @typedef {import("./LoopProps.ts").LoopProps} LoopProps */
/**
 * @param {LoopProps} props
 */
declare function Loop(props: LoopProps$1): React__default.ReactElement<{
    id: string | undefined;
    until: boolean | undefined;
    maxIterations: number | undefined;
    onMaxReached: "fail" | "return-last" | undefined;
    continueAsNewEvery: number | undefined;
}, string | React__default.JSXElementConstructor<any>> | null;
/** @typedef {import("./LoopProps.ts").LoopProps} LoopProps */
/**
 * @param {LoopProps} props
 */
declare function Ralph(props: LoopProps$1): React__default.ReactElement<{
    id: string | undefined;
    until: boolean | undefined;
    maxIterations: number | undefined;
    onMaxReached: "fail" | "return-last" | undefined;
    continueAsNewEvery: number | undefined;
}, string | React__default.JSXElementConstructor<any>> | null;
type LoopProps$1 = LoopProps$2;

/**
 * @param {ContinueAsNewProps} props
 */
declare function ContinueAsNew(props: ContinueAsNewProps$1): React__default.ReactElement<{
    stateJson: string | undefined;
}, string | React__default.JSXElementConstructor<any>>;
/**
 * Convenience helper for conditional continuation inside workflow JSX:
 * `{shouldContinue ? continueAsNew({ cursor }) : null}`
 * @param {unknown} [state]
 * @returns {React.ReactElement}
 */
declare function continueAsNew(state?: unknown): React__default.ReactElement;
type ContinueAsNewProps$1 = ContinueAsNewProps$2;

/**
 * Declare a browser React UI owned by the workflow module.
 *
 * The component is metadata only: it renders nothing into the workflow graph,
 * and the Gateway discovers it from the workflow's JSX before any run starts.
 *
 * @param {import("./UIProps.ts").UIProps} _props
 * @returns {null}
 */
declare function UI(_props: UIProps$1): null;
/**
 * Declare an OpenTUI React UI owned by the workflow module.
 *
 * Like `<UI>`, this is metadata only and does not affect workflow execution.
 *
 * @param {import("./UIProps.ts").TUIProps} _props
 * @returns {null}
 */
declare function TUI(_props: TUIProps$1): null;
declare const SMITHERS_WORKFLOW_VIEW_KIND: unique symbol;

/**
 * How to read run state. This is an architectural rule, not a preference: the
 * store is private to the engine, and a monitor that opens it races the very
 * run it is watching.
 * @returns {string[]}
 */
declare function monitorReadPathRules(): string[];
/**
 * What healthy and unhealthy actually look like, stated concretely enough that
 * two different agents sampling the same run reach the same verdict.
 * @param {{ stallBeats?: number; intervalMs?: number }} [params]
 * @returns {string[]}
 */
declare function monitorHealthSignals(params?: {
    stallBeats?: number;
    intervalMs?: number;
}): string[];
/**
 * The evidence contract: what must be in hand BEFORE a condition is named or an
 * action is taken. A monitor that acts on one reading is a monitor that flaps.
 * @returns {string[]}
 */
declare function monitorEvidenceRules(): string[];
/**
 * What the monitor may do by itself, and where the line is. Biased hard toward
 * observing and reporting: the monitor's job is to keep the run alive, not to
 * take over from it.
 * @param {{ autoHeal?: readonly MonitorCondition[]; watchRunId?: string }} [params]
 * @returns {string[]}
 */
declare function monitorAuthorityRules(params?: {
    autoHeal?: readonly MonitorCondition$1[];
    watchRunId?: string;
}): string[];
/**
 * Assemble the full monitoring prompt.
 *
 * @param {{
 *   watchRunId?: string;
 *   intervalMs?: number;
 *   stallBeats?: number;
 *   autoHeal?: readonly MonitorCondition[];
 *   guidance?: string;
 * }} [params]
 * @returns {string}
 */
declare function monitorPrompt(params?: {
    watchRunId?: string;
    intervalMs?: number;
    stallBeats?: number;
    autoHeal?: readonly MonitorCondition$1[];
    guidance?: string;
}): string;
/** @typedef {import("./MonitorCondition.ts").MonitorCondition} MonitorCondition */
/**
 * The monitoring doctrine `<Monitor>` ships with.
 *
 * Prompt text lives IN this package (a seeded workflow pack cannot import
 * `.smithers/prompts`), the same way `delegation/delegationPrompts.js` does.
 * `MonitorPrompt.mdx` renders these exact sections as an MDX prompt component
 * so a monitor file can import and extend it with JSX; keeping the strings here
 * means the `.mdx` and the component default can never drift apart.
 */
/**
 * The closed condition set, as a runtime value. Kept in the same order the
 * router evaluates it so the prompt and the switch always agree.
 * @type {readonly MonitorCondition[]}
 */
declare const MONITOR_CONDITIONS: readonly MonitorCondition$1[];
/** Run statuses that mean the watched run is over and the monitor should stop. */
declare const MONITOR_TERMINAL_STATUSES: readonly ["finished", "failed", "cancelled", "continued"];
/**
 * The conditions a monitor may repair on its own by default when no active
 * runtime owner exists. Retry remains a bounded reset, so the prompt requires
 * reporting its effects and never applying it twice.
 * @type {readonly MonitorCondition[]}
 */
declare const MONITOR_DEFAULT_AUTO_HEAL: readonly MonitorCondition$1[];
type MonitorCondition$1 = MonitorCondition$2;

/** @typedef {import("./SagaStepProps.ts").SagaStepProps} SagaStepProps */
/**
 * Declarative marker for a Saga step. Exported as a value so `import { SagaStep }`
 * works; also available as `<Saga.Step>`.
 *
 * @param {SagaStepProps} _props
 * @returns {React.ReactElement | null}
 */
declare function SagaStep(_props: SagaStepProps$1): React__default.ReactElement | null;
declare namespace SagaStep {
    let __isSagaStep: boolean;
}
/**
 * Forward steps with registered compensations executed in reverse on failure/cancel.
 *
 * Use the `steps` prop for an array-driven API, or nest `<Saga.Step>` children
 * for a declarative JSX style.
 *
 * Renders to `<smithers:saga>`.
 * @param {SagaProps} props
 */
declare function Saga(props: SagaProps$1): React__default.ReactElement<{
    id: string | undefined;
    onFailure: "fail" | "compensate" | "compensate-and-fail";
    __sagaSteps: {
        id: any;
        label: any;
    }[];
    skipIf?: boolean;
}, string | React__default.JSXElementConstructor<any>> | null;
declare namespace Saga {
    export { SagaStep as Step };
}
type SagaStepProps$1 = SagaStepProps$2;
type SagaProps$1 = SagaProps$2;

/**
 * Best-effort working-copy commit probe. Tries jj first (this is how a
 * colocated repo stays truthful — the same `commit_id` probe as packages/vcs
 * `getJjPointer`, so `from..to` ranges work for both jj
 * and git tooling), then falls back to `git rev-parse HEAD`. Returns null
 * when neither VCS answers — callers must treat that as "omit the field".
 * @param {string} cwd
 * @returns {Promise<{ commit: string; vcs: "jj" | "git" } | null>}
 */
declare function captureWorkingCopyCommit(cwd: string): Promise<{
    commit: string;
    vcs: "jj" | "git";
} | null>;
/**
 * Wrap an exec agent so every structured output gains a measured
 * `commitRange`: the working-copy commit is probed BEFORE `generate` runs and
 * AFTER it finishes, and `{ from, to, vcs }` is merged into the returned
 * `output` object. Strictly best-effort by contract: any probe failure, a
 * non-object result, or a text-only result leaves the output untouched —
 * commit capture must never fail an execution.
 *
 * Implemented as a Proxy so `instanceof`-based agent handling (CLI tool
 * allowlists, engine capability checks) still sees the underlying agent.
 * Caveat: code paths that RECONSTRUCT an agent from `agent.opts` (e.g. the
 * explicit-only tool allowlist) drop the wrapper — capture is then simply
 * absent, which the schema allows.
 * @param {AgentLike | AgentLike[]} agent
 * @param {(cwd: string) => Promise<{ commit: string; vcs: "jj" | "git" } | null>} [probe]
 *   The working-copy commit probe. Defaults to `captureWorkingCopyCommit`;
 *   injectable so the best-effort `.catch` fallback (a probe that rejects
 *   rather than resolving null) is exercisable.
 * @returns {AgentLike | AgentLike[]}
 */
declare function withCommitRange(agent: AgentLike | AgentLike[], probe?: (cwd: string) => Promise<{
    commit: string;
    vcs: "jj" | "git";
} | null>): AgentLike | AgentLike[];
type AgentLike = _smthrs_agents_AgentLike.AgentLike;

/** Wire versions are integers; registry/compiler versions are immutable runtime strings. */
declare const DELEGATION_V2_PROTOCOL_VERSION: 2;
declare const DELEGATION_V2_PROGRAM_VERSION: 1;
declare const DELEGATION_V2_REGISTRY_VERSION: "delegation-v2.registry-2";
declare const authorEnvelopeSchema: z.ZodObject<{
    protocolVersion: z.ZodLiteral<2>;
    outcome: z.ZodDiscriminatedUnion<[z.ZodObject<{
        tag: z.ZodLiteral<"subworkflow">;
        value: z.ZodObject<{
            schemaVersion: z.ZodOptional<z.ZodUnknown>;
            registryVersion: z.ZodOptional<z.ZodUnknown>;
            id: z.ZodOptional<z.ZodUnknown>;
            objective: z.ZodOptional<z.ZodUnknown>;
            rationale: z.ZodOptional<z.ZodUnknown>;
            root: z.ZodOptional<z.ZodUnknown>;
            outputs: z.ZodOptional<z.ZodUnknown>;
            supersedes: z.ZodOptional<z.ZodUnknown>;
        }, z.core.$catchall<z.ZodUnknown>>;
    }, z.core.$strict>, z.ZodObject<{
        tag: z.ZodLiteral<"complete">;
        value: z.ZodDiscriminatedUnion<[z.ZodObject<{
            details: any;
            summary: z.ZodString;
            acceptance: z.ZodArray<z.ZodObject<{
                criterionId: z.ZodString;
                status: z.ZodEnum<{
                    unknown: "unknown";
                    passed: "passed";
                    failed: "failed";
                }>;
                evidenceIds: z.ZodArray<z.ZodString>;
                explanation: z.ZodString;
            }, z.core.$strict>>;
            evidence: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                kind: z.ZodEnum<{
                    source: "source";
                    artifact: "artifact";
                    observation: "observation";
                    test: "test";
                    analysis: "analysis";
                    user_input: "user_input";
                }>;
                summary: z.ZodString;
                locator: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            artifacts: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                kind: z.ZodEnum<{
                    file: "file";
                    preview: "preview";
                    url: "url";
                    report: "report";
                    diff: "diff";
                    command_output: "command_output";
                    other: "other";
                }>;
                locator: z.ZodString;
                summary: z.ZodString;
            }, z.core.$strict>>;
            assumptions: z.ZodArray<z.ZodString>;
            openRisks: z.ZodArray<z.ZodObject<{
                risk: z.ZodString;
                impact: z.ZodString;
                mitigation: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            work: z.ZodLiteral<any>;
        }, z.core.$strict>, z.ZodObject<{
            details: any;
            summary: z.ZodString;
            acceptance: z.ZodArray<z.ZodObject<{
                criterionId: z.ZodString;
                status: z.ZodEnum<{
                    unknown: "unknown";
                    passed: "passed";
                    failed: "failed";
                }>;
                evidenceIds: z.ZodArray<z.ZodString>;
                explanation: z.ZodString;
            }, z.core.$strict>>;
            evidence: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                kind: z.ZodEnum<{
                    source: "source";
                    artifact: "artifact";
                    observation: "observation";
                    test: "test";
                    analysis: "analysis";
                    user_input: "user_input";
                }>;
                summary: z.ZodString;
                locator: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            artifacts: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                kind: z.ZodEnum<{
                    file: "file";
                    preview: "preview";
                    url: "url";
                    report: "report";
                    diff: "diff";
                    command_output: "command_output";
                    other: "other";
                }>;
                locator: z.ZodString;
                summary: z.ZodString;
            }, z.core.$strict>>;
            assumptions: z.ZodArray<z.ZodString>;
            openRisks: z.ZodArray<z.ZodObject<{
                risk: z.ZodString;
                impact: z.ZodString;
                mitigation: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            work: z.ZodLiteral<any>;
        }, z.core.$strict>, z.ZodObject<{
            details: any;
            summary: z.ZodString;
            acceptance: z.ZodArray<z.ZodObject<{
                criterionId: z.ZodString;
                status: z.ZodEnum<{
                    unknown: "unknown";
                    passed: "passed";
                    failed: "failed";
                }>;
                evidenceIds: z.ZodArray<z.ZodString>;
                explanation: z.ZodString;
            }, z.core.$strict>>;
            evidence: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                kind: z.ZodEnum<{
                    source: "source";
                    artifact: "artifact";
                    observation: "observation";
                    test: "test";
                    analysis: "analysis";
                    user_input: "user_input";
                }>;
                summary: z.ZodString;
                locator: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            artifacts: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                kind: z.ZodEnum<{
                    file: "file";
                    preview: "preview";
                    url: "url";
                    report: "report";
                    diff: "diff";
                    command_output: "command_output";
                    other: "other";
                }>;
                locator: z.ZodString;
                summary: z.ZodString;
            }, z.core.$strict>>;
            assumptions: z.ZodArray<z.ZodString>;
            openRisks: z.ZodArray<z.ZodObject<{
                risk: z.ZodString;
                impact: z.ZodString;
                mitigation: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            work: z.ZodLiteral<any>;
        }, z.core.$strict>, z.ZodObject<{
            details: any;
            summary: z.ZodString;
            acceptance: z.ZodArray<z.ZodObject<{
                criterionId: z.ZodString;
                status: z.ZodEnum<{
                    unknown: "unknown";
                    passed: "passed";
                    failed: "failed";
                }>;
                evidenceIds: z.ZodArray<z.ZodString>;
                explanation: z.ZodString;
            }, z.core.$strict>>;
            evidence: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                kind: z.ZodEnum<{
                    source: "source";
                    artifact: "artifact";
                    observation: "observation";
                    test: "test";
                    analysis: "analysis";
                    user_input: "user_input";
                }>;
                summary: z.ZodString;
                locator: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            artifacts: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                kind: z.ZodEnum<{
                    file: "file";
                    preview: "preview";
                    url: "url";
                    report: "report";
                    diff: "diff";
                    command_output: "command_output";
                    other: "other";
                }>;
                locator: z.ZodString;
                summary: z.ZodString;
            }, z.core.$strict>>;
            assumptions: z.ZodArray<z.ZodString>;
            openRisks: z.ZodArray<z.ZodObject<{
                risk: z.ZodString;
                impact: z.ZodString;
                mitigation: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            work: z.ZodLiteral<any>;
        }, z.core.$strict>, z.ZodObject<{
            details: any;
            summary: z.ZodString;
            acceptance: z.ZodArray<z.ZodObject<{
                criterionId: z.ZodString;
                status: z.ZodEnum<{
                    unknown: "unknown";
                    passed: "passed";
                    failed: "failed";
                }>;
                evidenceIds: z.ZodArray<z.ZodString>;
                explanation: z.ZodString;
            }, z.core.$strict>>;
            evidence: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                kind: z.ZodEnum<{
                    source: "source";
                    artifact: "artifact";
                    observation: "observation";
                    test: "test";
                    analysis: "analysis";
                    user_input: "user_input";
                }>;
                summary: z.ZodString;
                locator: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            artifacts: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                kind: z.ZodEnum<{
                    file: "file";
                    preview: "preview";
                    url: "url";
                    report: "report";
                    diff: "diff";
                    command_output: "command_output";
                    other: "other";
                }>;
                locator: z.ZodString;
                summary: z.ZodString;
            }, z.core.$strict>>;
            assumptions: z.ZodArray<z.ZodString>;
            openRisks: z.ZodArray<z.ZodObject<{
                risk: z.ZodString;
                impact: z.ZodString;
                mitigation: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            work: z.ZodLiteral<any>;
        }, z.core.$strict>, z.ZodObject<{
            details: any;
            summary: z.ZodString;
            acceptance: z.ZodArray<z.ZodObject<{
                criterionId: z.ZodString;
                status: z.ZodEnum<{
                    unknown: "unknown";
                    passed: "passed";
                    failed: "failed";
                }>;
                evidenceIds: z.ZodArray<z.ZodString>;
                explanation: z.ZodString;
            }, z.core.$strict>>;
            evidence: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                kind: z.ZodEnum<{
                    source: "source";
                    artifact: "artifact";
                    observation: "observation";
                    test: "test";
                    analysis: "analysis";
                    user_input: "user_input";
                }>;
                summary: z.ZodString;
                locator: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            artifacts: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                kind: z.ZodEnum<{
                    file: "file";
                    preview: "preview";
                    url: "url";
                    report: "report";
                    diff: "diff";
                    command_output: "command_output";
                    other: "other";
                }>;
                locator: z.ZodString;
                summary: z.ZodString;
            }, z.core.$strict>>;
            assumptions: z.ZodArray<z.ZodString>;
            openRisks: z.ZodArray<z.ZodObject<{
                risk: z.ZodString;
                impact: z.ZodString;
                mitigation: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            work: z.ZodLiteral<any>;
        }, z.core.$strict>, z.ZodObject<{
            details: any;
            summary: z.ZodString;
            acceptance: z.ZodArray<z.ZodObject<{
                criterionId: z.ZodString;
                status: z.ZodEnum<{
                    unknown: "unknown";
                    passed: "passed";
                    failed: "failed";
                }>;
                evidenceIds: z.ZodArray<z.ZodString>;
                explanation: z.ZodString;
            }, z.core.$strict>>;
            evidence: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                kind: z.ZodEnum<{
                    source: "source";
                    artifact: "artifact";
                    observation: "observation";
                    test: "test";
                    analysis: "analysis";
                    user_input: "user_input";
                }>;
                summary: z.ZodString;
                locator: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            artifacts: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                kind: z.ZodEnum<{
                    file: "file";
                    preview: "preview";
                    url: "url";
                    report: "report";
                    diff: "diff";
                    command_output: "command_output";
                    other: "other";
                }>;
                locator: z.ZodString;
                summary: z.ZodString;
            }, z.core.$strict>>;
            assumptions: z.ZodArray<z.ZodString>;
            openRisks: z.ZodArray<z.ZodObject<{
                risk: z.ZodString;
                impact: z.ZodString;
                mitigation: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            work: z.ZodLiteral<any>;
        }, z.core.$strict>, z.ZodObject<{
            details: any;
            summary: z.ZodString;
            acceptance: z.ZodArray<z.ZodObject<{
                criterionId: z.ZodString;
                status: z.ZodEnum<{
                    unknown: "unknown";
                    passed: "passed";
                    failed: "failed";
                }>;
                evidenceIds: z.ZodArray<z.ZodString>;
                explanation: z.ZodString;
            }, z.core.$strict>>;
            evidence: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                kind: z.ZodEnum<{
                    source: "source";
                    artifact: "artifact";
                    observation: "observation";
                    test: "test";
                    analysis: "analysis";
                    user_input: "user_input";
                }>;
                summary: z.ZodString;
                locator: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            artifacts: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                kind: z.ZodEnum<{
                    file: "file";
                    preview: "preview";
                    url: "url";
                    report: "report";
                    diff: "diff";
                    command_output: "command_output";
                    other: "other";
                }>;
                locator: z.ZodString;
                summary: z.ZodString;
            }, z.core.$strict>>;
            assumptions: z.ZodArray<z.ZodString>;
            openRisks: z.ZodArray<z.ZodObject<{
                risk: z.ZodString;
                impact: z.ZodString;
                mitigation: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            work: z.ZodLiteral<any>;
        }, z.core.$strict>], "work">;
    }, z.core.$strict>, z.ZodObject<{
        tag: z.ZodLiteral<"blocked">;
        value: z.ZodObject<{
            summary: z.ZodString;
            partialWork: z.ZodString;
            attemptedAlternatives: z.ZodArray<z.ZodString>;
            whyNoSafeFallbackExists: z.ZodString;
            requiredNextAction: z.ZodString;
            evidence: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                kind: z.ZodEnum<{
                    source: "source";
                    artifact: "artifact";
                    observation: "observation";
                    test: "test";
                    analysis: "analysis";
                    user_input: "user_input";
                }>;
                summary: z.ZodString;
                locator: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            openRisks: z.ZodArray<z.ZodObject<{
                risk: z.ZodString;
                impact: z.ZodString;
                mitigation: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            work: z.ZodEnum<{
                synthesize: "synthesize";
                plan: "plan";
                review: "review";
                preview: "preview";
                poc: "poc";
                research: "research";
                refine_goal: "refine_goal";
                execute: "execute";
            }>;
        }, z.core.$strict>;
    }, z.core.$strict>], "tag">;
    state: z.ZodObject<{
        summary: z.ZodString;
        retainedFacts: z.ZodArray<z.ZodString>;
        openRisks: z.ZodArray<z.ZodObject<{
            risk: z.ZodString;
            impact: z.ZodString;
            mitigation: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
    }, z.core.$strict>;
}, z.core.$strict>;
declare const workerEnvelopeSchema: z.ZodObject<{
    protocolVersion: z.ZodLiteral<2>;
    outcome: z.ZodDiscriminatedUnion<[z.ZodObject<{
        tag: z.ZodLiteral<"complete">;
        value: z.ZodDiscriminatedUnion<[z.ZodObject<{
            details: any;
            summary: z.ZodString;
            acceptance: z.ZodArray<z.ZodObject<{
                criterionId: z.ZodString;
                status: z.ZodEnum<{
                    unknown: "unknown";
                    passed: "passed";
                    failed: "failed";
                }>;
                evidenceIds: z.ZodArray<z.ZodString>;
                explanation: z.ZodString;
            }, z.core.$strict>>;
            evidence: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                kind: z.ZodEnum<{
                    source: "source";
                    artifact: "artifact";
                    observation: "observation";
                    test: "test";
                    analysis: "analysis";
                    user_input: "user_input";
                }>;
                summary: z.ZodString;
                locator: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            artifacts: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                kind: z.ZodEnum<{
                    file: "file";
                    preview: "preview";
                    url: "url";
                    report: "report";
                    diff: "diff";
                    command_output: "command_output";
                    other: "other";
                }>;
                locator: z.ZodString;
                summary: z.ZodString;
            }, z.core.$strict>>;
            assumptions: z.ZodArray<z.ZodString>;
            openRisks: z.ZodArray<z.ZodObject<{
                risk: z.ZodString;
                impact: z.ZodString;
                mitigation: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            work: z.ZodLiteral<any>;
        }, z.core.$strict>, z.ZodObject<{
            details: any;
            summary: z.ZodString;
            acceptance: z.ZodArray<z.ZodObject<{
                criterionId: z.ZodString;
                status: z.ZodEnum<{
                    unknown: "unknown";
                    passed: "passed";
                    failed: "failed";
                }>;
                evidenceIds: z.ZodArray<z.ZodString>;
                explanation: z.ZodString;
            }, z.core.$strict>>;
            evidence: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                kind: z.ZodEnum<{
                    source: "source";
                    artifact: "artifact";
                    observation: "observation";
                    test: "test";
                    analysis: "analysis";
                    user_input: "user_input";
                }>;
                summary: z.ZodString;
                locator: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            artifacts: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                kind: z.ZodEnum<{
                    file: "file";
                    preview: "preview";
                    url: "url";
                    report: "report";
                    diff: "diff";
                    command_output: "command_output";
                    other: "other";
                }>;
                locator: z.ZodString;
                summary: z.ZodString;
            }, z.core.$strict>>;
            assumptions: z.ZodArray<z.ZodString>;
            openRisks: z.ZodArray<z.ZodObject<{
                risk: z.ZodString;
                impact: z.ZodString;
                mitigation: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            work: z.ZodLiteral<any>;
        }, z.core.$strict>, z.ZodObject<{
            details: any;
            summary: z.ZodString;
            acceptance: z.ZodArray<z.ZodObject<{
                criterionId: z.ZodString;
                status: z.ZodEnum<{
                    unknown: "unknown";
                    passed: "passed";
                    failed: "failed";
                }>;
                evidenceIds: z.ZodArray<z.ZodString>;
                explanation: z.ZodString;
            }, z.core.$strict>>;
            evidence: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                kind: z.ZodEnum<{
                    source: "source";
                    artifact: "artifact";
                    observation: "observation";
                    test: "test";
                    analysis: "analysis";
                    user_input: "user_input";
                }>;
                summary: z.ZodString;
                locator: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            artifacts: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                kind: z.ZodEnum<{
                    file: "file";
                    preview: "preview";
                    url: "url";
                    report: "report";
                    diff: "diff";
                    command_output: "command_output";
                    other: "other";
                }>;
                locator: z.ZodString;
                summary: z.ZodString;
            }, z.core.$strict>>;
            assumptions: z.ZodArray<z.ZodString>;
            openRisks: z.ZodArray<z.ZodObject<{
                risk: z.ZodString;
                impact: z.ZodString;
                mitigation: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            work: z.ZodLiteral<any>;
        }, z.core.$strict>, z.ZodObject<{
            details: any;
            summary: z.ZodString;
            acceptance: z.ZodArray<z.ZodObject<{
                criterionId: z.ZodString;
                status: z.ZodEnum<{
                    unknown: "unknown";
                    passed: "passed";
                    failed: "failed";
                }>;
                evidenceIds: z.ZodArray<z.ZodString>;
                explanation: z.ZodString;
            }, z.core.$strict>>;
            evidence: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                kind: z.ZodEnum<{
                    source: "source";
                    artifact: "artifact";
                    observation: "observation";
                    test: "test";
                    analysis: "analysis";
                    user_input: "user_input";
                }>;
                summary: z.ZodString;
                locator: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            artifacts: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                kind: z.ZodEnum<{
                    file: "file";
                    preview: "preview";
                    url: "url";
                    report: "report";
                    diff: "diff";
                    command_output: "command_output";
                    other: "other";
                }>;
                locator: z.ZodString;
                summary: z.ZodString;
            }, z.core.$strict>>;
            assumptions: z.ZodArray<z.ZodString>;
            openRisks: z.ZodArray<z.ZodObject<{
                risk: z.ZodString;
                impact: z.ZodString;
                mitigation: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            work: z.ZodLiteral<any>;
        }, z.core.$strict>, z.ZodObject<{
            details: any;
            summary: z.ZodString;
            acceptance: z.ZodArray<z.ZodObject<{
                criterionId: z.ZodString;
                status: z.ZodEnum<{
                    unknown: "unknown";
                    passed: "passed";
                    failed: "failed";
                }>;
                evidenceIds: z.ZodArray<z.ZodString>;
                explanation: z.ZodString;
            }, z.core.$strict>>;
            evidence: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                kind: z.ZodEnum<{
                    source: "source";
                    artifact: "artifact";
                    observation: "observation";
                    test: "test";
                    analysis: "analysis";
                    user_input: "user_input";
                }>;
                summary: z.ZodString;
                locator: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            artifacts: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                kind: z.ZodEnum<{
                    file: "file";
                    preview: "preview";
                    url: "url";
                    report: "report";
                    diff: "diff";
                    command_output: "command_output";
                    other: "other";
                }>;
                locator: z.ZodString;
                summary: z.ZodString;
            }, z.core.$strict>>;
            assumptions: z.ZodArray<z.ZodString>;
            openRisks: z.ZodArray<z.ZodObject<{
                risk: z.ZodString;
                impact: z.ZodString;
                mitigation: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            work: z.ZodLiteral<any>;
        }, z.core.$strict>, z.ZodObject<{
            details: any;
            summary: z.ZodString;
            acceptance: z.ZodArray<z.ZodObject<{
                criterionId: z.ZodString;
                status: z.ZodEnum<{
                    unknown: "unknown";
                    passed: "passed";
                    failed: "failed";
                }>;
                evidenceIds: z.ZodArray<z.ZodString>;
                explanation: z.ZodString;
            }, z.core.$strict>>;
            evidence: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                kind: z.ZodEnum<{
                    source: "source";
                    artifact: "artifact";
                    observation: "observation";
                    test: "test";
                    analysis: "analysis";
                    user_input: "user_input";
                }>;
                summary: z.ZodString;
                locator: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            artifacts: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                kind: z.ZodEnum<{
                    file: "file";
                    preview: "preview";
                    url: "url";
                    report: "report";
                    diff: "diff";
                    command_output: "command_output";
                    other: "other";
                }>;
                locator: z.ZodString;
                summary: z.ZodString;
            }, z.core.$strict>>;
            assumptions: z.ZodArray<z.ZodString>;
            openRisks: z.ZodArray<z.ZodObject<{
                risk: z.ZodString;
                impact: z.ZodString;
                mitigation: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            work: z.ZodLiteral<any>;
        }, z.core.$strict>, z.ZodObject<{
            details: any;
            summary: z.ZodString;
            acceptance: z.ZodArray<z.ZodObject<{
                criterionId: z.ZodString;
                status: z.ZodEnum<{
                    unknown: "unknown";
                    passed: "passed";
                    failed: "failed";
                }>;
                evidenceIds: z.ZodArray<z.ZodString>;
                explanation: z.ZodString;
            }, z.core.$strict>>;
            evidence: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                kind: z.ZodEnum<{
                    source: "source";
                    artifact: "artifact";
                    observation: "observation";
                    test: "test";
                    analysis: "analysis";
                    user_input: "user_input";
                }>;
                summary: z.ZodString;
                locator: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            artifacts: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                kind: z.ZodEnum<{
                    file: "file";
                    preview: "preview";
                    url: "url";
                    report: "report";
                    diff: "diff";
                    command_output: "command_output";
                    other: "other";
                }>;
                locator: z.ZodString;
                summary: z.ZodString;
            }, z.core.$strict>>;
            assumptions: z.ZodArray<z.ZodString>;
            openRisks: z.ZodArray<z.ZodObject<{
                risk: z.ZodString;
                impact: z.ZodString;
                mitigation: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            work: z.ZodLiteral<any>;
        }, z.core.$strict>, z.ZodObject<{
            details: any;
            summary: z.ZodString;
            acceptance: z.ZodArray<z.ZodObject<{
                criterionId: z.ZodString;
                status: z.ZodEnum<{
                    unknown: "unknown";
                    passed: "passed";
                    failed: "failed";
                }>;
                evidenceIds: z.ZodArray<z.ZodString>;
                explanation: z.ZodString;
            }, z.core.$strict>>;
            evidence: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                kind: z.ZodEnum<{
                    source: "source";
                    artifact: "artifact";
                    observation: "observation";
                    test: "test";
                    analysis: "analysis";
                    user_input: "user_input";
                }>;
                summary: z.ZodString;
                locator: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            artifacts: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                kind: z.ZodEnum<{
                    file: "file";
                    preview: "preview";
                    url: "url";
                    report: "report";
                    diff: "diff";
                    command_output: "command_output";
                    other: "other";
                }>;
                locator: z.ZodString;
                summary: z.ZodString;
            }, z.core.$strict>>;
            assumptions: z.ZodArray<z.ZodString>;
            openRisks: z.ZodArray<z.ZodObject<{
                risk: z.ZodString;
                impact: z.ZodString;
                mitigation: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            work: z.ZodLiteral<any>;
        }, z.core.$strict>], "work">;
    }, z.core.$strict>, z.ZodObject<{
        tag: z.ZodLiteral<"blocked">;
        value: z.ZodObject<{
            summary: z.ZodString;
            partialWork: z.ZodString;
            attemptedAlternatives: z.ZodArray<z.ZodString>;
            whyNoSafeFallbackExists: z.ZodString;
            requiredNextAction: z.ZodString;
            evidence: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                kind: z.ZodEnum<{
                    source: "source";
                    artifact: "artifact";
                    observation: "observation";
                    test: "test";
                    analysis: "analysis";
                    user_input: "user_input";
                }>;
                summary: z.ZodString;
                locator: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            openRisks: z.ZodArray<z.ZodObject<{
                risk: z.ZodString;
                impact: z.ZodString;
                mitigation: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            work: z.ZodEnum<{
                synthesize: "synthesize";
                plan: "plan";
                review: "review";
                preview: "preview";
                poc: "poc";
                research: "research";
                refine_goal: "refine_goal";
                execute: "execute";
            }>;
        }, z.core.$strict>;
    }, z.core.$strict>], "tag">;
}, z.core.$strict>;
/** Nonblocking ask-question tool payload. Runtime identity is attached outside model output. */
declare const dv2QuestionSchema: z.ZodObject<{
    key: z.ZodString;
    target: z.ZodEnum<{
        human: "human";
        parent: "parent";
    }>;
    question: z.ZodString;
    whyItMatters: z.ZodString;
    fallbackAssumption: z.ZodString;
    impactIfWrong: z.ZodString;
    choices: z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        label: z.ZodString;
        description: z.ZodString;
    }, z.core.$strict>>>;
}, z.core.$strict>;
declare const dv2AnswerSchema: z.ZodObject<{
    key: z.ZodString;
    source: z.ZodEnum<{
        human: "human";
        parent: "parent";
    }>;
    answer: z.ZodString;
    answeredAtMs: z.ZodNumber;
    replacesFallback: z.ZodBoolean;
}, z.core.$strict>;
/** Trusted validation row. Rejected programs retain a digest but never normalized IR. */
declare const dv2ValidationSchema: z.ZodObject<{
    invocationKey: z.ZodString;
    generation: z.ZodNumber;
    authorNodeId: z.ZodString;
    status: z.ZodEnum<{
        accepted: "accepted";
        rejected: "rejected";
    }>;
    programDigest: z.ZodString;
    registryVersion: z.ZodString;
    compilerVersion: z.ZodString;
    criticalExecutionPolicyHash: z.ZodOptional<z.ZodString>;
    normalizedProgram: z.ZodOptional<z.ZodObject<{
        schemaVersion: z.ZodLiteral<1>;
        registryVersion: z.ZodString;
        id: z.ZodString;
        objective: z.ZodObject<{
            objective: z.ZodString;
            context: z.ZodArray<z.ZodString>;
            constraints: z.ZodArray<z.ZodString>;
            nonGoals: z.ZodArray<z.ZodString>;
        }, z.core.$strict>;
        rationale: z.ZodString;
        root: any;
        outputs: z.ZodArray<z.ZodObject<{
            from: z.ZodString;
            contract: z.ZodEnum<{
                plan: "plan";
                goal_contract: "goal_contract";
                work_product: "work_product";
                evidence_collection: "evidence_collection";
                issue_scan: "issue_scan";
                classification: "classification";
                condition: "condition";
                evaluation: "evaluation";
                artifact_collection: "artifact_collection";
            }>;
        }, z.core.$strict>>;
        supersedes: z.ZodOptional<z.ZodObject<{
            id: z.ZodString;
            digest: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    diagnostics: z.ZodArray<z.ZodObject<{
        code: z.ZodEnum<{
            schema_invalid: "schema_invalid";
            registry_mismatch: "registry_mismatch";
            duplicate_id: "duplicate_id";
            reserved_id: "reserved_id";
            node_limit: "node_limit";
            depth_limit: "depth_limit";
            fanout_limit: "fanout_limit";
            concurrency_limit: "concurrency_limit";
            unsupported_nested_concurrency: "unsupported_nested_concurrency";
            prompt_limit: "prompt_limit";
            total_prompt_limit: "total_prompt_limit";
            author_fuel_limit: "author_fuel_limit";
            role_work_forbidden: "role_work_forbidden";
            acceptance_duplicate: "acceptance_duplicate";
            author_depth_limit: "author_depth_limit";
            criticality_required: "criticality_required";
            criticality_forbidden: "criticality_forbidden";
            criticality_ungranted: "criticality_ungranted";
            criticality_policy_mismatch: "criticality_policy_mismatch";
            critical_review_missing: "critical_review_missing";
            critical_review_invalid: "critical_review_invalid";
            critical_review_not_independent: "critical_review_not_independent";
            critical_review_not_joined: "critical_review_not_joined";
            reference_missing: "reference_missing";
            reference_forward: "reference_forward";
            reference_contract_mismatch: "reference_contract_mismatch";
            parallel_sibling_reference: "parallel_sibling_reference";
            prompt_context_missing: "prompt_context_missing";
            output_missing: "output_missing";
            output_contract_mismatch: "output_contract_mismatch";
            output_contract_forbidden: "output_contract_forbidden";
            output_duplicate: "output_duplicate";
            parallel_write_conflict: "parallel_write_conflict";
        }>;
        path: z.ZodString;
        message: z.ZodString;
        nodeId: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
    stats: z.ZodOptional<z.ZodObject<{
        nodes: z.ZodNumber;
        agents: z.ZodNumber;
        authors: z.ZodNumber;
        maxDepth: z.ZodNumber;
        maxFanout: z.ZodNumber;
        totalPromptBytes: z.ZodNumber;
    }, z.core.$strict>>;
}, z.core.$strict>;
/** Uniform trusted settlement row consumed by author continuations. */
declare const dv2OutcomeSchema: z.ZodObject<{
    invocationKey: z.ZodString;
    logicalId: z.ZodString;
    generation: z.ZodNumber;
    role: z.ZodEnum<{
        fable: "fable";
        sol: "sol";
        terra: "terra";
        luna: "luna";
    }>;
    work: z.ZodEnum<{
        synthesize: "synthesize";
        plan: "plan";
        review: "review";
        preview: "preview";
        poc: "poc";
        research: "research";
        refine_goal: "refine_goal";
        execute: "execute";
    }>;
    outputContract: z.ZodEnum<{
        plan: "plan";
        goal_contract: "goal_contract";
        work_product: "work_product";
        evidence_collection: "evidence_collection";
        issue_scan: "issue_scan";
        classification: "classification";
        condition: "condition";
        evaluation: "evaluation";
        artifact_collection: "artifact_collection";
    }>;
    assignmentDigest: z.ZodString;
    acceptanceCriterionIds: z.ZodArray<z.ZodString>;
    status: z.ZodEnum<{
        complete: "complete";
        blocked: "blocked";
        runtime_failed: "runtime_failed";
    }>;
    sourceNodeId: z.ZodString;
    programDigest: z.ZodOptional<z.ZodString>;
    product: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
        details: any;
        summary: z.ZodString;
        acceptance: z.ZodArray<z.ZodObject<{
            criterionId: z.ZodString;
            status: z.ZodEnum<{
                unknown: "unknown";
                passed: "passed";
                failed: "failed";
            }>;
            evidenceIds: z.ZodArray<z.ZodString>;
            explanation: z.ZodString;
        }, z.core.$strict>>;
        evidence: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            kind: z.ZodEnum<{
                source: "source";
                artifact: "artifact";
                observation: "observation";
                test: "test";
                analysis: "analysis";
                user_input: "user_input";
            }>;
            summary: z.ZodString;
            locator: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        artifacts: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            kind: z.ZodEnum<{
                file: "file";
                preview: "preview";
                url: "url";
                report: "report";
                diff: "diff";
                command_output: "command_output";
                other: "other";
            }>;
            locator: z.ZodString;
            summary: z.ZodString;
        }, z.core.$strict>>;
        assumptions: z.ZodArray<z.ZodString>;
        openRisks: z.ZodArray<z.ZodObject<{
            risk: z.ZodString;
            impact: z.ZodString;
            mitigation: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        work: z.ZodLiteral<any>;
    }, z.core.$strict>, z.ZodObject<{
        details: any;
        summary: z.ZodString;
        acceptance: z.ZodArray<z.ZodObject<{
            criterionId: z.ZodString;
            status: z.ZodEnum<{
                unknown: "unknown";
                passed: "passed";
                failed: "failed";
            }>;
            evidenceIds: z.ZodArray<z.ZodString>;
            explanation: z.ZodString;
        }, z.core.$strict>>;
        evidence: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            kind: z.ZodEnum<{
                source: "source";
                artifact: "artifact";
                observation: "observation";
                test: "test";
                analysis: "analysis";
                user_input: "user_input";
            }>;
            summary: z.ZodString;
            locator: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        artifacts: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            kind: z.ZodEnum<{
                file: "file";
                preview: "preview";
                url: "url";
                report: "report";
                diff: "diff";
                command_output: "command_output";
                other: "other";
            }>;
            locator: z.ZodString;
            summary: z.ZodString;
        }, z.core.$strict>>;
        assumptions: z.ZodArray<z.ZodString>;
        openRisks: z.ZodArray<z.ZodObject<{
            risk: z.ZodString;
            impact: z.ZodString;
            mitigation: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        work: z.ZodLiteral<any>;
    }, z.core.$strict>, z.ZodObject<{
        details: any;
        summary: z.ZodString;
        acceptance: z.ZodArray<z.ZodObject<{
            criterionId: z.ZodString;
            status: z.ZodEnum<{
                unknown: "unknown";
                passed: "passed";
                failed: "failed";
            }>;
            evidenceIds: z.ZodArray<z.ZodString>;
            explanation: z.ZodString;
        }, z.core.$strict>>;
        evidence: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            kind: z.ZodEnum<{
                source: "source";
                artifact: "artifact";
                observation: "observation";
                test: "test";
                analysis: "analysis";
                user_input: "user_input";
            }>;
            summary: z.ZodString;
            locator: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        artifacts: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            kind: z.ZodEnum<{
                file: "file";
                preview: "preview";
                url: "url";
                report: "report";
                diff: "diff";
                command_output: "command_output";
                other: "other";
            }>;
            locator: z.ZodString;
            summary: z.ZodString;
        }, z.core.$strict>>;
        assumptions: z.ZodArray<z.ZodString>;
        openRisks: z.ZodArray<z.ZodObject<{
            risk: z.ZodString;
            impact: z.ZodString;
            mitigation: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        work: z.ZodLiteral<any>;
    }, z.core.$strict>, z.ZodObject<{
        details: any;
        summary: z.ZodString;
        acceptance: z.ZodArray<z.ZodObject<{
            criterionId: z.ZodString;
            status: z.ZodEnum<{
                unknown: "unknown";
                passed: "passed";
                failed: "failed";
            }>;
            evidenceIds: z.ZodArray<z.ZodString>;
            explanation: z.ZodString;
        }, z.core.$strict>>;
        evidence: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            kind: z.ZodEnum<{
                source: "source";
                artifact: "artifact";
                observation: "observation";
                test: "test";
                analysis: "analysis";
                user_input: "user_input";
            }>;
            summary: z.ZodString;
            locator: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        artifacts: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            kind: z.ZodEnum<{
                file: "file";
                preview: "preview";
                url: "url";
                report: "report";
                diff: "diff";
                command_output: "command_output";
                other: "other";
            }>;
            locator: z.ZodString;
            summary: z.ZodString;
        }, z.core.$strict>>;
        assumptions: z.ZodArray<z.ZodString>;
        openRisks: z.ZodArray<z.ZodObject<{
            risk: z.ZodString;
            impact: z.ZodString;
            mitigation: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        work: z.ZodLiteral<any>;
    }, z.core.$strict>, z.ZodObject<{
        details: any;
        summary: z.ZodString;
        acceptance: z.ZodArray<z.ZodObject<{
            criterionId: z.ZodString;
            status: z.ZodEnum<{
                unknown: "unknown";
                passed: "passed";
                failed: "failed";
            }>;
            evidenceIds: z.ZodArray<z.ZodString>;
            explanation: z.ZodString;
        }, z.core.$strict>>;
        evidence: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            kind: z.ZodEnum<{
                source: "source";
                artifact: "artifact";
                observation: "observation";
                test: "test";
                analysis: "analysis";
                user_input: "user_input";
            }>;
            summary: z.ZodString;
            locator: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        artifacts: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            kind: z.ZodEnum<{
                file: "file";
                preview: "preview";
                url: "url";
                report: "report";
                diff: "diff";
                command_output: "command_output";
                other: "other";
            }>;
            locator: z.ZodString;
            summary: z.ZodString;
        }, z.core.$strict>>;
        assumptions: z.ZodArray<z.ZodString>;
        openRisks: z.ZodArray<z.ZodObject<{
            risk: z.ZodString;
            impact: z.ZodString;
            mitigation: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        work: z.ZodLiteral<any>;
    }, z.core.$strict>, z.ZodObject<{
        details: any;
        summary: z.ZodString;
        acceptance: z.ZodArray<z.ZodObject<{
            criterionId: z.ZodString;
            status: z.ZodEnum<{
                unknown: "unknown";
                passed: "passed";
                failed: "failed";
            }>;
            evidenceIds: z.ZodArray<z.ZodString>;
            explanation: z.ZodString;
        }, z.core.$strict>>;
        evidence: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            kind: z.ZodEnum<{
                source: "source";
                artifact: "artifact";
                observation: "observation";
                test: "test";
                analysis: "analysis";
                user_input: "user_input";
            }>;
            summary: z.ZodString;
            locator: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        artifacts: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            kind: z.ZodEnum<{
                file: "file";
                preview: "preview";
                url: "url";
                report: "report";
                diff: "diff";
                command_output: "command_output";
                other: "other";
            }>;
            locator: z.ZodString;
            summary: z.ZodString;
        }, z.core.$strict>>;
        assumptions: z.ZodArray<z.ZodString>;
        openRisks: z.ZodArray<z.ZodObject<{
            risk: z.ZodString;
            impact: z.ZodString;
            mitigation: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        work: z.ZodLiteral<any>;
    }, z.core.$strict>, z.ZodObject<{
        details: any;
        summary: z.ZodString;
        acceptance: z.ZodArray<z.ZodObject<{
            criterionId: z.ZodString;
            status: z.ZodEnum<{
                unknown: "unknown";
                passed: "passed";
                failed: "failed";
            }>;
            evidenceIds: z.ZodArray<z.ZodString>;
            explanation: z.ZodString;
        }, z.core.$strict>>;
        evidence: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            kind: z.ZodEnum<{
                source: "source";
                artifact: "artifact";
                observation: "observation";
                test: "test";
                analysis: "analysis";
                user_input: "user_input";
            }>;
            summary: z.ZodString;
            locator: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        artifacts: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            kind: z.ZodEnum<{
                file: "file";
                preview: "preview";
                url: "url";
                report: "report";
                diff: "diff";
                command_output: "command_output";
                other: "other";
            }>;
            locator: z.ZodString;
            summary: z.ZodString;
        }, z.core.$strict>>;
        assumptions: z.ZodArray<z.ZodString>;
        openRisks: z.ZodArray<z.ZodObject<{
            risk: z.ZodString;
            impact: z.ZodString;
            mitigation: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        work: z.ZodLiteral<any>;
    }, z.core.$strict>, z.ZodObject<{
        details: any;
        summary: z.ZodString;
        acceptance: z.ZodArray<z.ZodObject<{
            criterionId: z.ZodString;
            status: z.ZodEnum<{
                unknown: "unknown";
                passed: "passed";
                failed: "failed";
            }>;
            evidenceIds: z.ZodArray<z.ZodString>;
            explanation: z.ZodString;
        }, z.core.$strict>>;
        evidence: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            kind: z.ZodEnum<{
                source: "source";
                artifact: "artifact";
                observation: "observation";
                test: "test";
                analysis: "analysis";
                user_input: "user_input";
            }>;
            summary: z.ZodString;
            locator: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        artifacts: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            kind: z.ZodEnum<{
                file: "file";
                preview: "preview";
                url: "url";
                report: "report";
                diff: "diff";
                command_output: "command_output";
                other: "other";
            }>;
            locator: z.ZodString;
            summary: z.ZodString;
        }, z.core.$strict>>;
        assumptions: z.ZodArray<z.ZodString>;
        openRisks: z.ZodArray<z.ZodObject<{
            risk: z.ZodString;
            impact: z.ZodString;
            mitigation: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        work: z.ZodLiteral<any>;
    }, z.core.$strict>], "work">>;
    blockage: z.ZodOptional<z.ZodObject<{
        summary: z.ZodString;
        partialWork: z.ZodString;
        attemptedAlternatives: z.ZodArray<z.ZodString>;
        whyNoSafeFallbackExists: z.ZodString;
        requiredNextAction: z.ZodString;
        evidence: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            kind: z.ZodEnum<{
                source: "source";
                artifact: "artifact";
                observation: "observation";
                test: "test";
                analysis: "analysis";
                user_input: "user_input";
            }>;
            summary: z.ZodString;
            locator: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        openRisks: z.ZodArray<z.ZodObject<{
            risk: z.ZodString;
            impact: z.ZodString;
            mitigation: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        work: z.ZodEnum<{
            synthesize: "synthesize";
            plan: "plan";
            review: "review";
            preview: "preview";
            poc: "poc";
            research: "research";
            refine_goal: "refine_goal";
            execute: "execute";
        }>;
    }, z.core.$strict>>;
    runtimeFailure: z.ZodOptional<z.ZodObject<{
        code: z.ZodEnum<{
            cancelled: "cancelled";
            crash: "crash";
            timeout: "timeout";
            invalid_return: "invalid_return";
            budget_exhausted: "budget_exhausted";
            invalid_subworkflow: "invalid_subworkflow";
        }>;
        message: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>;
declare const dv2FinalSchema: z.ZodObject<{
    status: z.ZodEnum<{
        complete: "complete";
        blocked: "blocked";
        runtime_failed: "runtime_failed";
        fuel_exhausted: "fuel_exhausted";
    }>;
    summary: z.ZodString;
    outcome: z.ZodObject<{
        invocationKey: z.ZodString;
        logicalId: z.ZodString;
        generation: z.ZodNumber;
        role: z.ZodEnum<{
            fable: "fable";
            sol: "sol";
            terra: "terra";
            luna: "luna";
        }>;
        work: z.ZodEnum<{
            synthesize: "synthesize";
            plan: "plan";
            review: "review";
            preview: "preview";
            poc: "poc";
            research: "research";
            refine_goal: "refine_goal";
            execute: "execute";
        }>;
        outputContract: z.ZodEnum<{
            plan: "plan";
            goal_contract: "goal_contract";
            work_product: "work_product";
            evidence_collection: "evidence_collection";
            issue_scan: "issue_scan";
            classification: "classification";
            condition: "condition";
            evaluation: "evaluation";
            artifact_collection: "artifact_collection";
        }>;
        assignmentDigest: z.ZodString;
        acceptanceCriterionIds: z.ZodArray<z.ZodString>;
        status: z.ZodEnum<{
            complete: "complete";
            blocked: "blocked";
            runtime_failed: "runtime_failed";
        }>;
        sourceNodeId: z.ZodString;
        programDigest: z.ZodOptional<z.ZodString>;
        product: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
            details: any;
            summary: z.ZodString;
            acceptance: z.ZodArray<z.ZodObject<{
                criterionId: z.ZodString;
                status: z.ZodEnum<{
                    unknown: "unknown";
                    passed: "passed";
                    failed: "failed";
                }>;
                evidenceIds: z.ZodArray<z.ZodString>;
                explanation: z.ZodString;
            }, z.core.$strict>>;
            evidence: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                kind: z.ZodEnum<{
                    source: "source";
                    artifact: "artifact";
                    observation: "observation";
                    test: "test";
                    analysis: "analysis";
                    user_input: "user_input";
                }>;
                summary: z.ZodString;
                locator: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            artifacts: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                kind: z.ZodEnum<{
                    file: "file";
                    preview: "preview";
                    url: "url";
                    report: "report";
                    diff: "diff";
                    command_output: "command_output";
                    other: "other";
                }>;
                locator: z.ZodString;
                summary: z.ZodString;
            }, z.core.$strict>>;
            assumptions: z.ZodArray<z.ZodString>;
            openRisks: z.ZodArray<z.ZodObject<{
                risk: z.ZodString;
                impact: z.ZodString;
                mitigation: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            work: z.ZodLiteral<any>;
        }, z.core.$strict>, z.ZodObject<{
            details: any;
            summary: z.ZodString;
            acceptance: z.ZodArray<z.ZodObject<{
                criterionId: z.ZodString;
                status: z.ZodEnum<{
                    unknown: "unknown";
                    passed: "passed";
                    failed: "failed";
                }>;
                evidenceIds: z.ZodArray<z.ZodString>;
                explanation: z.ZodString;
            }, z.core.$strict>>;
            evidence: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                kind: z.ZodEnum<{
                    source: "source";
                    artifact: "artifact";
                    observation: "observation";
                    test: "test";
                    analysis: "analysis";
                    user_input: "user_input";
                }>;
                summary: z.ZodString;
                locator: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            artifacts: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                kind: z.ZodEnum<{
                    file: "file";
                    preview: "preview";
                    url: "url";
                    report: "report";
                    diff: "diff";
                    command_output: "command_output";
                    other: "other";
                }>;
                locator: z.ZodString;
                summary: z.ZodString;
            }, z.core.$strict>>;
            assumptions: z.ZodArray<z.ZodString>;
            openRisks: z.ZodArray<z.ZodObject<{
                risk: z.ZodString;
                impact: z.ZodString;
                mitigation: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            work: z.ZodLiteral<any>;
        }, z.core.$strict>, z.ZodObject<{
            details: any;
            summary: z.ZodString;
            acceptance: z.ZodArray<z.ZodObject<{
                criterionId: z.ZodString;
                status: z.ZodEnum<{
                    unknown: "unknown";
                    passed: "passed";
                    failed: "failed";
                }>;
                evidenceIds: z.ZodArray<z.ZodString>;
                explanation: z.ZodString;
            }, z.core.$strict>>;
            evidence: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                kind: z.ZodEnum<{
                    source: "source";
                    artifact: "artifact";
                    observation: "observation";
                    test: "test";
                    analysis: "analysis";
                    user_input: "user_input";
                }>;
                summary: z.ZodString;
                locator: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            artifacts: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                kind: z.ZodEnum<{
                    file: "file";
                    preview: "preview";
                    url: "url";
                    report: "report";
                    diff: "diff";
                    command_output: "command_output";
                    other: "other";
                }>;
                locator: z.ZodString;
                summary: z.ZodString;
            }, z.core.$strict>>;
            assumptions: z.ZodArray<z.ZodString>;
            openRisks: z.ZodArray<z.ZodObject<{
                risk: z.ZodString;
                impact: z.ZodString;
                mitigation: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            work: z.ZodLiteral<any>;
        }, z.core.$strict>, z.ZodObject<{
            details: any;
            summary: z.ZodString;
            acceptance: z.ZodArray<z.ZodObject<{
                criterionId: z.ZodString;
                status: z.ZodEnum<{
                    unknown: "unknown";
                    passed: "passed";
                    failed: "failed";
                }>;
                evidenceIds: z.ZodArray<z.ZodString>;
                explanation: z.ZodString;
            }, z.core.$strict>>;
            evidence: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                kind: z.ZodEnum<{
                    source: "source";
                    artifact: "artifact";
                    observation: "observation";
                    test: "test";
                    analysis: "analysis";
                    user_input: "user_input";
                }>;
                summary: z.ZodString;
                locator: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            artifacts: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                kind: z.ZodEnum<{
                    file: "file";
                    preview: "preview";
                    url: "url";
                    report: "report";
                    diff: "diff";
                    command_output: "command_output";
                    other: "other";
                }>;
                locator: z.ZodString;
                summary: z.ZodString;
            }, z.core.$strict>>;
            assumptions: z.ZodArray<z.ZodString>;
            openRisks: z.ZodArray<z.ZodObject<{
                risk: z.ZodString;
                impact: z.ZodString;
                mitigation: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            work: z.ZodLiteral<any>;
        }, z.core.$strict>, z.ZodObject<{
            details: any;
            summary: z.ZodString;
            acceptance: z.ZodArray<z.ZodObject<{
                criterionId: z.ZodString;
                status: z.ZodEnum<{
                    unknown: "unknown";
                    passed: "passed";
                    failed: "failed";
                }>;
                evidenceIds: z.ZodArray<z.ZodString>;
                explanation: z.ZodString;
            }, z.core.$strict>>;
            evidence: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                kind: z.ZodEnum<{
                    source: "source";
                    artifact: "artifact";
                    observation: "observation";
                    test: "test";
                    analysis: "analysis";
                    user_input: "user_input";
                }>;
                summary: z.ZodString;
                locator: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            artifacts: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                kind: z.ZodEnum<{
                    file: "file";
                    preview: "preview";
                    url: "url";
                    report: "report";
                    diff: "diff";
                    command_output: "command_output";
                    other: "other";
                }>;
                locator: z.ZodString;
                summary: z.ZodString;
            }, z.core.$strict>>;
            assumptions: z.ZodArray<z.ZodString>;
            openRisks: z.ZodArray<z.ZodObject<{
                risk: z.ZodString;
                impact: z.ZodString;
                mitigation: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            work: z.ZodLiteral<any>;
        }, z.core.$strict>, z.ZodObject<{
            details: any;
            summary: z.ZodString;
            acceptance: z.ZodArray<z.ZodObject<{
                criterionId: z.ZodString;
                status: z.ZodEnum<{
                    unknown: "unknown";
                    passed: "passed";
                    failed: "failed";
                }>;
                evidenceIds: z.ZodArray<z.ZodString>;
                explanation: z.ZodString;
            }, z.core.$strict>>;
            evidence: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                kind: z.ZodEnum<{
                    source: "source";
                    artifact: "artifact";
                    observation: "observation";
                    test: "test";
                    analysis: "analysis";
                    user_input: "user_input";
                }>;
                summary: z.ZodString;
                locator: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            artifacts: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                kind: z.ZodEnum<{
                    file: "file";
                    preview: "preview";
                    url: "url";
                    report: "report";
                    diff: "diff";
                    command_output: "command_output";
                    other: "other";
                }>;
                locator: z.ZodString;
                summary: z.ZodString;
            }, z.core.$strict>>;
            assumptions: z.ZodArray<z.ZodString>;
            openRisks: z.ZodArray<z.ZodObject<{
                risk: z.ZodString;
                impact: z.ZodString;
                mitigation: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            work: z.ZodLiteral<any>;
        }, z.core.$strict>, z.ZodObject<{
            details: any;
            summary: z.ZodString;
            acceptance: z.ZodArray<z.ZodObject<{
                criterionId: z.ZodString;
                status: z.ZodEnum<{
                    unknown: "unknown";
                    passed: "passed";
                    failed: "failed";
                }>;
                evidenceIds: z.ZodArray<z.ZodString>;
                explanation: z.ZodString;
            }, z.core.$strict>>;
            evidence: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                kind: z.ZodEnum<{
                    source: "source";
                    artifact: "artifact";
                    observation: "observation";
                    test: "test";
                    analysis: "analysis";
                    user_input: "user_input";
                }>;
                summary: z.ZodString;
                locator: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            artifacts: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                kind: z.ZodEnum<{
                    file: "file";
                    preview: "preview";
                    url: "url";
                    report: "report";
                    diff: "diff";
                    command_output: "command_output";
                    other: "other";
                }>;
                locator: z.ZodString;
                summary: z.ZodString;
            }, z.core.$strict>>;
            assumptions: z.ZodArray<z.ZodString>;
            openRisks: z.ZodArray<z.ZodObject<{
                risk: z.ZodString;
                impact: z.ZodString;
                mitigation: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            work: z.ZodLiteral<any>;
        }, z.core.$strict>, z.ZodObject<{
            details: any;
            summary: z.ZodString;
            acceptance: z.ZodArray<z.ZodObject<{
                criterionId: z.ZodString;
                status: z.ZodEnum<{
                    unknown: "unknown";
                    passed: "passed";
                    failed: "failed";
                }>;
                evidenceIds: z.ZodArray<z.ZodString>;
                explanation: z.ZodString;
            }, z.core.$strict>>;
            evidence: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                kind: z.ZodEnum<{
                    source: "source";
                    artifact: "artifact";
                    observation: "observation";
                    test: "test";
                    analysis: "analysis";
                    user_input: "user_input";
                }>;
                summary: z.ZodString;
                locator: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            artifacts: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                kind: z.ZodEnum<{
                    file: "file";
                    preview: "preview";
                    url: "url";
                    report: "report";
                    diff: "diff";
                    command_output: "command_output";
                    other: "other";
                }>;
                locator: z.ZodString;
                summary: z.ZodString;
            }, z.core.$strict>>;
            assumptions: z.ZodArray<z.ZodString>;
            openRisks: z.ZodArray<z.ZodObject<{
                risk: z.ZodString;
                impact: z.ZodString;
                mitigation: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            work: z.ZodLiteral<any>;
        }, z.core.$strict>], "work">>;
        blockage: z.ZodOptional<z.ZodObject<{
            summary: z.ZodString;
            partialWork: z.ZodString;
            attemptedAlternatives: z.ZodArray<z.ZodString>;
            whyNoSafeFallbackExists: z.ZodString;
            requiredNextAction: z.ZodString;
            evidence: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                kind: z.ZodEnum<{
                    source: "source";
                    artifact: "artifact";
                    observation: "observation";
                    test: "test";
                    analysis: "analysis";
                    user_input: "user_input";
                }>;
                summary: z.ZodString;
                locator: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            openRisks: z.ZodArray<z.ZodObject<{
                risk: z.ZodString;
                impact: z.ZodString;
                mitigation: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            work: z.ZodEnum<{
                synthesize: "synthesize";
                plan: "plan";
                review: "review";
                preview: "preview";
                poc: "poc";
                research: "research";
                refine_goal: "refine_goal";
                execute: "execute";
            }>;
        }, z.core.$strict>>;
        runtimeFailure: z.ZodOptional<z.ZodObject<{
            code: z.ZodEnum<{
                cancelled: "cancelled";
                crash: "crash";
                timeout: "timeout";
                invalid_return: "invalid_return";
                budget_exhausted: "budget_exhausted";
                invalid_subworkflow: "invalid_subworkflow";
            }>;
            message: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>;
}, z.core.$strict>;
declare namespace delegationV2Schemas {
    export { authorEnvelopeSchema as dv2Author };
    export { workerEnvelopeSchema as dv2Worker };
    export { dv2ValidationSchema as dv2Validation };
    export { dv2OutcomeSchema as dv2Outcome };
    export { dv2FinalSchema as dv2Final };
    export { dv2QuestionSchema as dv2Question };
    export { dv2AnswerSchema as dv2Answer };
}

/** @param {import("./delegationV2Schemas.ts").WorkflowProgram} program */
declare function delegationV2ProgramDigest(program: WorkflowProgram): string;
/**
 * Validate and normalize the model-authored v1 program without side effects.
 * Accepted digests are always over the strict Zod-normalized program.
 *
 * @param {unknown} rawProgram
 * @param {{
 *   limits?: Partial<typeof DEFAULT_DELEGATION_V2_LIMITS>,
 *   rootMaxConcurrency?: number,
 *   allowParallelWrites?: boolean,
 *   reservedIds?: readonly string[],
 *   registryVersion?: string,
 *   expectedRegistryVersion?: string,
 *   criticalExecutionPolicy?: unknown,
 *   criticalReviewIndependentRoles?: unknown,
 *   allowAuthorChildren?: boolean,
 *   hasCappedParallelAncestor?: boolean,
 * }} [options]
 * @returns {{
 *   ok: boolean,
 *   status: "accepted" | "rejected",
 *   programDigest: string,
 *   normalizedProgram?: import("./delegationV2Schemas.ts").WorkflowProgram,
 *   diagnostics: Array<{code: string, path: string, message: string, nodeId?: string}>,
 *   stats: {nodes: number, agents: number, authors: number, maxDepth: number, maxFanout: number, totalPromptBytes: number},
 * }}
 */
declare function validateWorkflowProgram(rawProgram: unknown, options?: {
    limits?: Partial<typeof DEFAULT_DELEGATION_V2_LIMITS>;
    rootMaxConcurrency?: number;
    allowParallelWrites?: boolean;
    reservedIds?: readonly string[];
    registryVersion?: string;
    expectedRegistryVersion?: string;
    criticalExecutionPolicy?: unknown;
    criticalReviewIndependentRoles?: unknown;
    allowAuthorChildren?: boolean;
    hasCappedParallelAncestor?: boolean;
}): {
    ok: boolean;
    status: "accepted" | "rejected";
    programDigest: string;
    normalizedProgram?: WorkflowProgram;
    diagnostics: Array<{
        code: string;
        path: string;
        message: string;
        nodeId?: string;
    }>;
    stats: {
        nodes: number;
        agents: number;
        authors: number;
        maxDepth: number;
        maxFanout: number;
        totalPromptBytes: number;
    };
};
declare const DEFAULT_DELEGATION_V2_LIMITS: Readonly<{
    maxNodes: 64;
    maxDepth: 8;
    maxFanout: 16;
    maxConcurrency: 8;
    maxAuthors: 16;
    maxPromptBytes: 16384;
    maxTotalPromptBytes: 131072;
}>;

/**
 * Lower one accepted `agent | sequence | parallel` program into a deterministic,
 * JSON-only render plan. The caller renders this plan with trusted Smithers
 * components; the model never supplies React props, agents, tools, callbacks,
 * schemas, commands, or providers.
 *
 * `programDigest` must be the semantic digest of the normalized persisted program. The
 * check is intentional: otherwise changed prompt semantics could accidentally
 * reuse physical task IDs from a different accepted fragment.
 *
 * @param {{
 *   program: unknown,
 *   invocationKey: string,
 *   authorNodeId: string,
 *   generation: number,
 *   programDigest: string,
 *   rootMaxConcurrency: number,
 *   prefix?: string,
 *   authorLineage?: string[],
 *   entryDependsOn?: string[],
 *   validationLimits?: Record<string, number>,
 *   allowParallelWrites?: boolean,
 *   criticalExecutionPolicy?: unknown,
 *   criticalReviewIndependentRoles?: unknown,
 *   allowAuthorChildren?: boolean,
 *   hasCappedParallelAncestor?: boolean,
 * }} options
 */
declare function compileDelegationV2Program(options: {
    program: unknown;
    invocationKey: string;
    authorNodeId: string;
    generation: number;
    programDigest: string;
    rootMaxConcurrency: number;
    prefix?: string;
    authorLineage?: string[];
    entryDependsOn?: string[];
    validationLimits?: Record<string, number>;
    allowParallelWrites?: boolean;
    criticalExecutionPolicy?: unknown;
    criticalReviewIndependentRoles?: unknown;
    allowAuthorChildren?: boolean;
    hasCappedParallelAncestor?: boolean;
}): {
    kind: string;
    compilerVersion: string;
    schemaVersion: 1;
    registryVersion: string;
    invocationKey: string;
    authorNodeId: string;
    authorLineage: string[];
    generation: number;
    programId: string;
    programDigest: string;
    rootMaxConcurrency: number;
    hasCappedParallelAncestor: boolean;
    criticalExecutionPolicyHash: string | null;
    criticalReviewIndependentRoles: {
        sol: string[];
        fable: string[];
    } | null;
    objective: {
        objective: string;
        context: string[];
        constraints: string[];
        nonGoals: string[];
    };
    rationale: string;
    entryDependencyNodeIds: string[];
    completionOutcomeNodeIds: string[];
    declaredOutputs: {
        from: string;
        contract: "plan" | "goal_contract" | "work_product" | "evidence_collection" | "issue_scan" | "classification" | "condition" | "evaluation" | "artifact_collection";
        outcomeNodeId: any;
    }[];
    declaredOutputNodeIds: any[];
    nodeIndex: Record<string, any>[];
    root: Record<string, any>;
};
/**
 * Version of the pure Phase A IR lowerer. Persist this beside accepted IR so a
 * resumed run never silently changes the meaning of an older program.
 */
declare const DELEGATION_V2_COMPILER_VERSION: "delegation-v2.compiler-3";

/**
 * Partition one invocation's remaining subtree fuel into disjoint immutable
 * budgets for its continuation and immediate nested authors. Unused child fuel
 * is intentionally not reclaimed: that keeps replay a pure fold over persisted
 * rows and makes the global upper bound independent of scheduling order.
 *
 * @param {{nestedLogicalIds: readonly string[], remainingTurns: number, parentCapacity: number}} options
 */
declare function partitionDelegationV2AuthorFuel(options: {
    nestedLogicalIds: readonly string[];
    remainingTurns: number;
    parentCapacity: number;
}): {
    parentTurns: number;
    childTurns: Record<string, number>;
    allocatedTurns: number;
};
/**
 * Turn an otherwise accepted program into a typed rejection before any child
 * is mounted when the current subtree cannot fund every nested author and one
 * mandatory parent continuation.
 *
 * @param {Record<string, any>} validation
 * @param {number} remainingTurns
 */
declare function enforceDelegationV2AuthorFuel(validation: Record<string, any>, remainingTurns: number): Record<string, any>;

type ApprovalAutoApprove = ApprovalAutoApprove$1;
type ApprovalDecision = ApprovalDecision$1;
type ApprovalGateProps = ApprovalGateProps$2;
type ApprovalMode = ApprovalMode$1;
type ApprovalOption = ApprovalOption$1;
type ApprovalProps<Row, Output> = ApprovalProps$2<Row, Output>;
type ApprovalRanking = ApprovalRanking$1;
type ApprovalRequest = ApprovalRequest$1;
type ApprovalSelection = ApprovalSelection$1;
type AspectsProps = AspectsProps$2;
type BranchProps = BranchProps$2;
type CategoryConfig = CategoryConfig$1;
type CheckConfig = CheckConfig$1;
type CheckSuiteProps = CheckSuiteProps$2;
type ClassifyAndRouteProps = ClassifyAndRouteProps$2;
type ColumnDef = ColumnDef$1;
type ContentPipelineProps = ContentPipelineProps$2;
type ContentPipelineStage = ContentPipelineStage$1;
type ContinueAsNewProps = ContinueAsNewProps$2;
type DebateProps = DebateProps$2;
type DecisionRule = DecisionRule$1;
type DecisionTableProps = DecisionTableProps$2;
type DelegationAgents = DelegationAgents$1;
type DelegationBudget = DelegationBudget$1;
type DelegationChainProps = DelegationChainProps$2;
type DelegationEditListenerProps = DelegationEditListenerProps$2;
type DelegationExecutionProps = DelegationExecutionProps$2;
type DelegationOutputs = DelegationOutputs$1;
type DelegationPlanningProps = DelegationPlanningProps$2;
type DelegationPreviewProps = DelegationPreviewProps$2;
type DelegationScoringProps = DelegationScoringProps$2;
type DelegationScorers = DelegationScorers$1;
type DelegationSharedProps = DelegationSharedProps$1;
type BackpressurePlanningProps = BackpressurePlanningProps$2;
type DeriskLoopProps = DeriskLoopProps$2;
type GoalRefinementProps = GoalRefinementProps$2;
type Tier = Tier$3;
type Estimate = Estimate$1;
type Gate = Gate$1;
type DcGoalRow = DcGoalRow$1;
type DcQuestionRow = DcQuestionRow$1;
type DcForecastRow = DcForecastRow$1;
type DcGoalApprovalRow = DcGoalApprovalRow$1;
type DcPlanRow = DcPlanRow$2;
type DcPreviewRow = DcPreviewRow$1;
type DcDevPreviewRow = DcDevPreviewRow$1;
type DevPreviewKind = DevPreviewKind$1;
type DcGatesRow = DcGatesRow$2;
type DcProbeRow = DcProbeRow$1;
type DcReplanRow = DcReplanRow$1;
type DcExecRow = DcExecRow$1;
type DcReviewRow = DcReviewRow$1;
type DcApprovalRow = DcApprovalRow$1;
type DcEditRow = DcEditRow$1;
type DcSkipRow = DcSkipRow$1;
type DcPollRow = DcPollRow$1;
type DcBudgetRow = DcBudgetRow$1;
type DcScoreRow = DcScoreRow$1;
type DepsSpec = DepsSpec$1;
type DriftDetectorProps = DriftDetectorProps$2;
type EscalationChainProps = EscalationChainProps$2;
type EscalationLevel = EscalationLevel$1;
type GatherAndSynthesizeProps = GatherAndSynthesizeProps$2;
type HumanTaskProps = HumanTaskProps$2;
type InferDeps<D> = InferDeps$1<D>;
type KanbanProps = KanbanProps$2;
type LoopProps = LoopProps$2;
type MergeQueueProps = MergeQueueProps$2;
type MemoryProps = MemoryProps$2;
type MonitorCondition = MonitorCondition$2;
type MonitorProps = MonitorProps$2;
type OptimizerProps = OptimizerProps$2;
type OutputTarget = OutputTarget$1;
type PanelistConfig = PanelistConfig$1;
type PanelProps = PanelProps$2;
type ParallelProps = ParallelProps$2;
type PollerProps = PollerProps$2;
type RalphProps = RalphProps$1;
type ReviewLoopProps = ReviewLoopProps$2;
type RunbookProps = RunbookProps$2;
type RunbookStep = RunbookStep$1;
type SagaProps = SagaProps$2;
type SagaStepDef = SagaStepDef$1;
type SagaStepProps = SagaStepProps$2;
type SandboxEgressConfig = SandboxEgressConfig$1;
type SandboxProps = SandboxProps$2;
type SandboxRuntime = SandboxRuntime$1;
type SandboxVolumeMount = SandboxVolumeMount$1;
type SandboxWorkspaceSpec = SandboxWorkspaceSpec$1;
type ScanFixVerifyProps = ScanFixVerifyProps$2;
type ScorersMap = _smthrs_graph_types.ScorersMap;
type SequenceProps = SequenceProps$2;
type SidecarDelta = SidecarDelta$2;
type SidecarProps = SidecarProps$2;
type SignalProps<Schema> = SignalProps$2<Schema>;
type SourceDef = SourceDef$1;
type SubflowProps = SubflowProps$2;
type SuperSmithersProps = SuperSmithersProps$2;
type SupervisorProps = SupervisorProps$2;
type TaskProps$1<Row, Output, D> = TaskProps$2<Row, Output, D>;
type TimerProps = TimerProps$2;
type TryCatchFinallyProps = TryCatchFinallyProps$2;
type TrellisProps = TrellisProps$2;
type TUIProps = TUIProps$1;
type UIProps = UIProps$1;
type WorkflowViewBootProps = WorkflowViewBootProps$1;
type WorkflowViewProps = WorkflowViewProps$1;
type WaitForEventProps = WaitForEventProps$2;
type WorkflowFileRef = WorkflowFileRef$1;
type WorkflowProps = WorkflowProps$2;
type WorktreeProps = WorktreeProps$2;

/** @type {Record<string, React.FC<any>>} */
declare const markdownComponents: Record<string, React__default.FC<any>>;

/** @typedef {import("react").ComponentType<Record<string, any>>} MDXContent */
/**
 * Render an MDX component to plain markdown text.
 *
 * Injects `markdownComponents` so headings, paragraphs, code blocks, etc.
 * render as markdown-formatted text instead of HTML tags.
 *
 * @param {MDXContent} Component
 * @param {Record<string, any>} [props]
 * @returns {string}
 */
declare function renderMdx(Component: MDXContent, props?: Record<string, any>): string;
type MDXContent = React$1.ComponentType<Record<string, any>>;

/** @typedef {import("zod").ZodObject<import("zod").ZodRawShape>} ZodObject */
/** @typedef {import("zod").ZodTypeAny} ZodTypeAny */
/**
 * @param {ZodObject} schema
 * @returns {string}
 */
declare function zodSchemaToJsonExample(schema: ZodObject): string;
type ZodObject = zod.ZodObject<zod.ZodRawShape>;

type CachePolicy<Ctx> = _smthrs_scheduler_CachePolicy.CachePolicy<Ctx>;
type EngineDecision = _smthrs_scheduler.EngineDecision;
type ExtractOptions = _smthrs_graph.ExtractOptions;
type HostElement = _smthrs_graph.HostElement;
type HostNode = _smthrs_graph.HostNode;
type HostText = _smthrs_graph.HostText;
type InferOutputEntry<T> = _smthrs_driver_OutputAccessor.InferOutputEntry<T>;
type InferRow<TTable> = _smthrs_driver_OutputAccessor.InferRow<TTable>;
type OutputAccessor<Schema> = _smthrs_driver_OutputAccessor.OutputAccessor<Schema>;
type OutputKey = _smthrs_driver_OutputKey.OutputKey;
type RenderContext = _smthrs_scheduler.RenderContext;
type RetryPolicy = _smthrs_scheduler_RetryPolicy.RetryPolicy;
type RunAuthContext = _smthrs_driver_RunAuthContext.RunAuthContext;
type RunOptions = _smthrs_driver.RunOptions;
type RunResult = _smthrs_driver.RunResult;
type SchemaRegistryEntry = _smthrs_db_SchemaRegistryEntry.SchemaRegistryEntry;
type SmithersAlertLabels = _smthrs_scheduler_SmithersWorkflowOptions.SmithersAlertLabels;
type SmithersAlertPolicy = _smthrs_scheduler_SmithersWorkflowOptions.SmithersAlertPolicy;
type SmithersAlertPolicyDefaults = _smthrs_scheduler_SmithersWorkflowOptions.SmithersAlertPolicyDefaults;
type SmithersAlertPolicyRule = _smthrs_scheduler_SmithersWorkflowOptions.SmithersAlertPolicyRule;
type SmithersAlertReaction = _smthrs_scheduler_SmithersWorkflowOptions.SmithersAlertReaction;
type SmithersAlertReactionKind = _smthrs_scheduler_SmithersWorkflowOptions.SmithersAlertReactionKind;
type SmithersAlertReactionRef = _smthrs_scheduler_SmithersWorkflowOptions.SmithersAlertReactionRef;
type SmithersAlertSeverity = _smthrs_scheduler_SmithersWorkflowOptions.SmithersAlertSeverity;
type SmithersCtx = _smthrs_driver.SmithersCtx;
type SmithersErrorCode = _smthrs_errors_SmithersErrorCode.SmithersErrorCode;
type SmithersWorkflow<Schema> = _smthrs_driver_WorkflowDefinition.WorkflowDefinition<Schema>;
type SmithersWorkflowDriverOptions<Schema> = _smthrs_driver_WorkflowDriverOptions.WorkflowDriverOptions<Schema>;
type SmithersWorkflowOptions = _smthrs_scheduler.SmithersWorkflowOptions;
type TaskDescriptor = _smthrs_graph.TaskDescriptor;
type WaitReason = _smthrs_scheduler.WaitReason;
type WorkflowGraph = _smthrs_graph.WorkflowGraph;
type WorkflowRuntime = _smthrs_driver_workflow_types.WorkflowRuntime;
type WorkflowSession = _smthrs_driver_workflow_types.WorkflowSession;
type XmlElement = _smthrs_graph.XmlElement;
type XmlNode = _smthrs_graph.XmlNode;
type XmlText = _smthrs_graph.XmlText;

export { Approval, type ApprovalAutoApprove, type ApprovalDecision, ApprovalGate, type ApprovalGateProps, type ApprovalMode, type ApprovalOption, type ApprovalProps, type ApprovalRanking, type ApprovalRequest, type ApprovalSelection, Aspects, type AspectsProps, BackpressurePlanning, type BackpressurePlanningProps, Branch, type BranchProps, type CachePolicy, type CategoryConfig, type CheckConfig, CheckSuite, type CheckSuiteProps, ClassifyAndRoute, type ClassifyAndRouteProps, type ColumnDef, ContentPipeline, type ContentPipelineProps, type ContentPipelineStage, ContinueAsNew, type ContinueAsNewProps, DC_EDIT_SIGNAL, DC_SKIP_PREVIEW_SIGNAL, DEFAULT_DELEGATION_V2_LIMITS, DEFAULT_TIER_ORDER, DELEGATION_V2_COMPILER_VERSION, DELEGATION_V2_PROGRAM_VERSION, DELEGATION_V2_PROTOCOL_VERSION, DELEGATION_V2_REGISTRY_VERSION, DELEGATION_V2_RUNTIME_VERSION, DELEGATION_V2_SETTLEMENT_VERSION, type DcApprovalRow, type DcBudgetRow, type DcDevPreviewRow, type DcEditRow, type DcExecRow, type DcForecastRow, type DcGatesRow, type DcGoalApprovalRow, type DcGoalRow, type DcPlanRow, type DcPollRow, type DcPreviewRow, type DcProbeRow, type DcQuestionRow, type DcReplanRow, type DcReviewRow, type DcScoreRow, type DcSkipRow, Debate, type DebateProps, type DecisionRule, DecisionTable, type DecisionTableProps, type DelegationAgents, type DelegationBudget, DelegationChain, type DelegationChainProps, DelegationEditListener, type DelegationEditListenerProps, DelegationExecution, type DelegationExecutionProps, type DelegationOutputs, DelegationPlanning, type DelegationPlanningProps, DelegationPreview, type DelegationPreviewProps, type DelegationScorers, DelegationScoring, type DelegationScoringProps, type DelegationSharedProps, type DepsSpec, DeriskLoop, type DeriskLoopProps, type DevPreviewKind, DriftDetector, type DriftDetectorProps, type EngineDecision, EscalationChain, type EscalationChainProps, type EscalationLevel, type Estimate, type ExtractOptions, type Gate, GatherAndSynthesize, type GatherAndSynthesizeProps, GoalRefinement, type GoalRefinementProps, type HostElement, type HostNode, type HostText, HumanTask, type HumanTaskProps, type InferDeps, type InferOutputEntry, type InferRow, Kanban, type KanbanProps, Loop, type LoopProps, MONITOR_CONDITIONS, MONITOR_DEFAULT_AUTO_HEAL, MONITOR_TERMINAL_STATUSES, Memory, type MemoryProps, MergeQueue, type MergeQueueProps, Monitor, type MonitorCondition, type MonitorProps, Optimizer, type OptimizerProps, type OutputAccessor, type OutputKey, type OutputTarget, Panel, type PanelProps, type PanelistConfig, Parallel, type ParallelProps, Poller, type PollerProps, Ralph, type RalphProps, type RenderContext, type RetryPolicy, ReviewLoop, type ReviewLoopProps, type RunAuthContext, type RunOptions, type RunResult, Runbook, type RunbookProps, type RunbookStep, SMITHERS_WORKFLOW_VIEW_KIND, Saga, type SagaProps, SagaStep, type SagaStepDef, type SagaStepProps, Sandbox, type SandboxEgressConfig, type SandboxProps, type SandboxRuntime, type SandboxVolumeMount, type SandboxWorkspaceSpec, ScanFixVerify, type ScanFixVerifyProps, type SchemaRegistryEntry, type ScorersMap, Sequence, type SequenceProps, Sidecar, type SidecarDelta, type SidecarProps, Signal, type SignalProps, type SmithersAlertLabels, type SmithersAlertPolicy, type SmithersAlertPolicyDefaults, type SmithersAlertPolicyRule, type SmithersAlertReaction, type SmithersAlertReactionKind, type SmithersAlertReactionRef, type SmithersAlertSeverity, type SmithersCtx, type SmithersErrorCode, type SmithersWorkflow, type SmithersWorkflowDriverOptions, type SmithersWorkflowOptions, type SourceDef, Subflow, type SubflowProps, SuperSmithers, type SuperSmithersProps, Supervisor, type SupervisorProps, TUI, type TUIProps, Task, type TaskDescriptor, type TaskProps$1 as TaskProps, type Tier, Timer, type TimerProps, Trellis, type TrellisProps, TryCatchFinally, type TryCatchFinallyProps, UI, type UIProps, WaitForEvent, type WaitForEventProps, type WaitReason, Workflow, type WorkflowFileRef, type WorkflowGraph, type WorkflowProps, type WorkflowRuntime, type WorkflowSession, type WorkflowViewBootProps, type WorkflowViewProps, Worktree, type WorktreeProps, type XmlElement, type XmlNode, type XmlText, actualTotals, agentForTier, approvalDecisionSchema, approvalRankingSchema, approvalSelectionSchema, captureWorkingCopyCommit, chunkGateFailures, compileDelegationV2Program, computeSidecarDelta, continueAsNew, dcApprovalSchema, dcBudgetSchema, dcDevPreviewSchema, dcEditSchema, dcExecSchema, dcForecastSchema, dcGatesSchema, dcGoalApprovalSchema, dcGoalSchema, dcPlanSchema, dcPollSchema, dcPreviewSchema, dcProbeSchema, dcQuestionSchema, dcReplanSchema, dcReviewSchema, dcScoreSchema, dcSkipSchema, delegationPrompts, delegationSchemas, delegationV2AssignmentDigest, delegationV2ProgramDigest, delegationV2Schemas, dependentsOf, devPreviewKindSchema, devPreviewNodeId, enforceDelegationV2AuthorFuel, estimateSchema, executionComplete, foldGates, foldPlans, frontierLeaves, gateSchema, leafAttemptState, leafComplete, leavesUnder, markdownComponents, monitorAuthorityRules, monitorEvidenceRules, monitorHealthSignals, monitorPrompt, monitorReadPathRules, nodeIndex, partitionDelegationV2AuthorFuel, pendingTriggers, physicalId, planOwnerOf, planningComplete, probeIdFor, probesRequested, renderMdx, renderPromptToText, replanCountFor, settleDelegationV2Envelope, splitGates, synthesizeDelegationEvents, tierSchema, delegationV2Prompts as trellisPrompts, triggerTargetOf, unplannedChunks, validateWorkflowProgram, withCommitRange, zodSchemaToJsonExample };
