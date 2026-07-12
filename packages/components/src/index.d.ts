import * as _smithers_orchestrator_driver_workflow_types from '@smithers-orchestrator/driver/workflow-types';
import * as _smithers_orchestrator_driver_WorkflowDriverOptions from '@smithers-orchestrator/driver/WorkflowDriverOptions';
import * as _smithers_orchestrator_driver_WorkflowDefinition from '@smithers-orchestrator/driver/WorkflowDefinition';
import { WorkflowDefinition } from '@smithers-orchestrator/driver/WorkflowDefinition';
import * as _smithers_orchestrator_errors_SmithersErrorCode from '@smithers-orchestrator/errors/SmithersErrorCode';
import { SmithersErrorCode as SmithersErrorCode$1 } from '@smithers-orchestrator/errors/SmithersErrorCode';
import * as _smithers_orchestrator_scheduler_SmithersWorkflowOptions from '@smithers-orchestrator/scheduler/SmithersWorkflowOptions';
import * as _smithers_orchestrator_db_SchemaRegistryEntry from '@smithers-orchestrator/db/SchemaRegistryEntry';
import * as _smithers_orchestrator_driver from '@smithers-orchestrator/driver';
import { SmithersCtx as SmithersCtx$1 } from '@smithers-orchestrator/driver';
import * as _smithers_orchestrator_driver_RunAuthContext from '@smithers-orchestrator/driver/RunAuthContext';
import * as _smithers_orchestrator_scheduler_RetryPolicy from '@smithers-orchestrator/scheduler/RetryPolicy';
import { RetryPolicy as RetryPolicy$1 } from '@smithers-orchestrator/scheduler/RetryPolicy';
import * as _smithers_orchestrator_driver_OutputKey from '@smithers-orchestrator/driver/OutputKey';
import * as _smithers_orchestrator_driver_OutputAccessor from '@smithers-orchestrator/driver/OutputAccessor';
import { InferOutputEntry as InferOutputEntry$1 } from '@smithers-orchestrator/driver/OutputAccessor';
import * as _smithers_orchestrator_graph from '@smithers-orchestrator/graph';
import * as _smithers_orchestrator_scheduler from '@smithers-orchestrator/scheduler';
import * as _smithers_orchestrator_scheduler_CachePolicy from '@smithers-orchestrator/scheduler/CachePolicy';
import { CachePolicy as CachePolicy$1 } from '@smithers-orchestrator/scheduler/CachePolicy';
import * as React from 'react';
import React__default from 'react';
import * as zod from 'zod';
import { z } from 'zod';
import { SmithersError } from '@smithers-orchestrator/errors/SmithersError';
import * as _smithers_orchestrator_agents_AgentLike from '@smithers-orchestrator/agents/AgentLike';
import { AgentLike as AgentLike$2 } from '@smithers-orchestrator/agents/AgentLike';
import * as _smithers_orchestrator_graph_types from '@smithers-orchestrator/graph/types';
import { ScorersMap as ScorersMap$1 } from '@smithers-orchestrator/graph/types';
import { TaskMemoryConfig } from '@smithers-orchestrator/memory/types';
import * as _smithers_orchestrator_errors from '@smithers-orchestrator/errors';
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
    /** Behavior on timeout: fail (default), skip the node, or continue with null. */
    onTimeout?: "fail" | "skip" | "continue";
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
    children?: string | Row | (() => Row | Promise<Row>) | React__default.ReactNode | ((deps: InferDeps$1<D>) => Row | React__default.ReactNode);
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
    /** The child workflow definition. */
    workflow: WorkflowDefinition<unknown>;
    /** Input to pass to the child workflow. */
    input?: unknown;
    /** `"childRun"` gets its own DB row/run; `"inline"` embeds in parent. */
    mode?: "childRun" | "inline";
    /** Where to store the subflow's result. */
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
    agent: AgentLike$2;
    sidecar: AgentLike$2;
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

type SidecarDelta$1 = {
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
type Tier$3 = z.infer<typeof tierSchema>;
/** Default tier ladder: fable plans root, opus plans chunks, sonnet executes leaves, haiku previews/probes. */
declare const DEFAULT_TIER_ORDER: readonly Tier$3[];
/** Durable signal event name for live user edits (fixed by contract — the UI submits to this key). */
declare const DC_EDIT_SIGNAL = "dc-edit";
/** Durable signal event name for skipping the zero-backpressure preview phase. */
declare const DC_SKIP_PREVIEW_SIGNAL = "dc-skip-preview";
/** A delegation node's predicted (or measured) resource envelope. */
declare const estimateSchema: z.ZodObject<{
    tokens: z.ZodNumber;
    costUsd: z.ZodNumber;
    minutes: z.ZodNumber;
}, z.core.$strip>;
type Estimate$1 = z.infer<typeof estimateSchema>;
/** Developer-preview gate kinds: what artifact proves the node's work is showable. */
declare const devPreviewKindSchema: z.ZodEnum<{
    app: "app";
    terminal: "terminal";
    api: "api";
    "throwaway-ui": "throwaway-ui";
    slideshow: "slideshow";
}>;
type DevPreviewKind$1 = z.infer<typeof devPreviewKindSchema>;
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
type Gate$1 = z.infer<typeof gateSchema>;
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
type DcGoalRow$1 = z.infer<typeof dcGoalSchema>;
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
type DcQuestionRow$1 = z.infer<typeof dcQuestionSchema>;
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
type DcForecastRow$1 = z.infer<typeof dcForecastSchema>;
/**
 * The human's refined-prompt approval (internal): the delegation UI submits
 * `{ approved, refinedPrompt }` to the `dc:<goal>:approve` HumanTask, and the
 * (possibly edited) refinedPrompt becomes the root planning brief.
 */
declare const dcGoalApprovalSchema: z.ZodObject<{
    approved: z.ZodBoolean;
    refinedPrompt: z.ZodString;
}, z.core.$strip>;
type DcGoalApprovalRow$1 = z.infer<typeof dcGoalApprovalSchema>;
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
type DcPlanRow$2 = z.infer<typeof dcPlanSchema>;
/** Zero-backpressure haiku render of a leaf's expected output. NEVER executed — calibration only. */
declare const dcPreviewSchema: z.ZodObject<{
    logicalId: z.ZodString;
    expectedOutput: z.ZodString;
}, z.core.$strip>;
type DcPreviewRow$1 = z.infer<typeof dcPreviewSchema>;
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
type DcGatesRow$2 = z.infer<typeof dcGatesSchema>;
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
type DcDevPreviewRow$1 = z.infer<typeof dcDevPreviewSchema>;
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
type DcProbeRow$1 = z.infer<typeof dcProbeSchema>;
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
type DcReplanRow$1 = z.infer<typeof dcReplanSchema>;
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
type DcExecRow$1 = z.infer<typeof dcExecSchema>;
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
type DcReviewRow$1 = z.infer<typeof dcReviewSchema>;
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
type DcApprovalRow$1 = z.infer<typeof dcApprovalSchema>;
/** Live user-edit signal payload (event name `dc-edit`). Each edit triggers a replan round. */
declare const dcEditSchema: z.ZodObject<{
    editId: z.ZodString;
    logicalId: z.ZodString;
    editedOutput: z.ZodUnknown;
    note: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
type DcEditRow$1 = z.infer<typeof dcEditSchema>;
/** Skip-previews signal payload (event name `dc-skip-preview`). */
declare const dcSkipSchema: z.ZodObject<{
    skipped: z.ZodBoolean;
}, z.core.$strip>;
type DcSkipRow$1 = z.infer<typeof dcSkipSchema>;
/** End-of-run satisfaction poll (HumanTask json form). */
declare const dcPollSchema: z.ZodObject<{
    answers: z.ZodArray<z.ZodObject<{
        question: z.ZodString;
        rating: z.ZodNumber;
    }, z.core.$strip>>;
    comment: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
type DcPollRow$1 = z.infer<typeof dcPollSchema>;
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
type DcBudgetRow$1 = z.infer<typeof dcBudgetSchema>;
/** Run-level scoring digest (internal): the row delegation run scorers evaluate. */
declare const dcScoreSchema: z.ZodObject<{
    logicalId: z.ZodString;
    summary: z.ZodString;
}, z.core.$strip>;
type DcScoreRow$1 = z.infer<typeof dcScoreSchema>;
/**
 * All delegation-chain tables keyed by table name — spread into
 * `createSmithers({ ...delegationSchemas })` to register them.
 */
declare const delegationSchemas: {
    readonly dcGoal: z.ZodObject<{
        logicalId: z.ZodDefault<z.ZodString>;
        refinedPrompt: z.ZodDefault<z.ZodString>;
        assumptions: z.ZodDefault<z.ZodArray<z.ZodString>>;
        questionsAsked: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>;
    readonly dcQuestion: z.ZodObject<{
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
    readonly dcForecast: z.ZodObject<{
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
    readonly dcGoalApproval: z.ZodObject<{
        approved: z.ZodBoolean;
        refinedPrompt: z.ZodString;
    }, z.core.$strip>;
    readonly dcPlan: z.ZodObject<{
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
    readonly dcPreview: z.ZodObject<{
        logicalId: z.ZodString;
        expectedOutput: z.ZodString;
    }, z.core.$strip>;
    readonly dcDevPreview: z.ZodObject<{
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
    readonly dcGates: z.ZodObject<{
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
    readonly dcProbe: z.ZodObject<{
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
    readonly dcReplan: z.ZodObject<{
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
    readonly dcExec: z.ZodObject<{
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
    readonly dcReview: z.ZodObject<{
        logicalId: z.ZodString;
        attempt: z.ZodNumber;
        verdict: z.ZodEnum<{
            fail: "fail";
            pass: "pass";
        }>;
        feedback: z.ZodString;
    }, z.core.$strip>;
    readonly dcApproval: z.ZodObject<{
        approved: z.ZodBoolean;
        note: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        decidedBy: z.ZodNullable<z.ZodString>;
        decidedAt: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>;
    readonly dcEdit: z.ZodObject<{
        editId: z.ZodString;
        logicalId: z.ZodString;
        editedOutput: z.ZodUnknown;
        note: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    readonly dcSkip: z.ZodObject<{
        skipped: z.ZodBoolean;
    }, z.core.$strip>;
    readonly dcPoll: z.ZodObject<{
        answers: z.ZodArray<z.ZodObject<{
            question: z.ZodString;
            rating: z.ZodNumber;
        }, z.core.$strip>>;
        comment: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    readonly dcBudget: z.ZodObject<{
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
    readonly dcScore: z.ZodObject<{
        logicalId: z.ZodString;
        summary: z.ZodString;
    }, z.core.$strip>;
};

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
     * `@smithers-orchestrator/gateway-react`) only recognize the default
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
    /** Delegation scorers (e.g. from `smithers-orchestrator/scorers`). */
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
    skipIf?: boolean;
    timeoutMs?: number;
    heartbeatTimeoutMs?: number;
    heartbeatTimeout?: number;
    retries?: number;
    retryPolicy?: _smithers_orchestrator_scheduler_RetryPolicy.RetryPolicy;
    continueOnFail?: boolean;
    cache?: _smithers_orchestrator_scheduler_CachePolicy.CachePolicy;
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
 * @template Row, Output, D
 * @param {TaskProps<Row, Output, D>} props
 * @returns {React.ReactElement | null}
 */
declare function Task<Row, Output, D>(props: TaskProps$1<Row, Output, D>): React__default.ReactElement | null;
type TaskProps$1<Row, Output, D> = TaskProps$2<Row, Output, D>;

/** @typedef {import("./SequenceProps.ts").SequenceProps} SequenceProps */
/**
 * @param {SequenceProps} props
 */
declare function Sequence(props: SequenceProps$1): React__default.DetailedReactHTMLElement<React__default.InputHTMLAttributes<HTMLInputElement>, HTMLInputElement> | null;
type SequenceProps$1 = SequenceProps$2;

/** @typedef {import("./ParallelProps.ts").ParallelProps} ParallelProps */
/**
 * @param {ParallelProps} props
 */
declare function Parallel(props: ParallelProps$1): React__default.ReactElement<{
    label?: string | undefined;
    priority?: number | undefined;
    failurePolicy?: "halt" | "quarantine" | undefined;
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
    maxConcurrency: number;
    priority: number;
    failurePolicy?: "halt" | "quarantine" | undefined;
    id: string | undefined;
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

type RowLike = {
    nodeId?: string;
    node_id?: string;
    scorerId?: string;
    scorer_id?: string;
    score?: number;
    scoredAtMs?: number;
    scored_at_ms?: number;
} & Record<string, unknown>;
type ComputeSidecarDeltaOptions = {
    primaryNodeId: string;
    sidecarNodeId: string;
    scorerId?: string;
};
declare function computeSidecarDelta(rows: RowLike[], opts: ComputeSidecarDeltaOptions): SidecarDelta$1;

/** @typedef {import("./SubflowProps.ts").SubflowProps} SubflowProps */
/**
 * @param {SubflowProps} props
 */
declare function Subflow(props: SubflowProps$1): React__default.ReactElement<{
    id: string;
    key: string | undefined;
    workflow: _smithers_orchestrator_driver.WorkflowDefinition<unknown>;
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
    cache: _smithers_orchestrator_scheduler.CachePolicy | undefined;
    dependsOn: string[] | undefined;
    needs: Record<string, string> | undefined;
    label: string;
    meta: Record<string, unknown> | undefined;
    __smithersSubflowWorkflow: _smithers_orchestrator_driver.WorkflowDefinition<unknown>;
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
    key: string | undefined;
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
    cache: _smithers_orchestrator_scheduler.CachePolicy | undefined;
    dependsOn: string[] | undefined;
    needs: Record<string, string> | undefined;
    label: string;
    meta: Record<string, unknown> | undefined;
    __smithersSandboxProvider: unknown;
    __smithersSandboxWorkflow: _smithers_orchestrator_driver.WorkflowDefinition<unknown> | undefined;
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
    key: string | undefined;
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
    key: string | undefined;
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
    __tcfCatchErrors: ("INVALID_INPUT" | "MISSING_INPUT" | "MISSING_INPUT_TABLE" | "RESUME_METADATA_MISMATCH" | "UNKNOWN_OUTPUT_SCHEMA" | "INVALID_OUTPUT" | "WORKTREE_CREATE_FAILED" | "VCS_NOT_FOUND" | "SNAPSHOT_NOT_FOUND" | "VCS_WORKSPACE_CREATE_FAILED" | "TASK_TIMEOUT" | "TASK_HIJACK_UNSUPPORTED" | "TASK_FORK_SOURCE_NOT_FOUND" | "TASK_FORK_SOURCE_NOT_COMPLETE" | "TASK_FORK_SESSION_UNAVAILABLE" | "TASK_FORK_CYCLE" | "RUN_NOT_FOUND" | "NODE_NOT_FOUND" | "INVALID_EVENTS_OPTIONS" | "SANDBOX_BUNDLE_INVALID" | "SANDBOX_BUNDLE_TOO_LARGE" | "WORKFLOW_EXECUTION_FAILED" | "SANDBOX_EXECUTION_FAILED" | "TASK_HEARTBEAT_TIMEOUT" | "HEARTBEAT_PAYLOAD_TOO_LARGE" | "HEARTBEAT_PAYLOAD_NOT_JSON_SERIALIZABLE" | "TASK_ABORTED" | "RUN_CANCELLED" | "RUN_NOT_RESUMABLE" | "RUN_OWNER_ALIVE" | "RUN_STILL_RUNNING" | "RUN_RESUME_CLAIM_LOST" | "RUN_RESUME_CLAIM_FAILED" | "RUN_RESUME_ACTIVATION_FAILED" | "RUN_HIJACKED" | "CONTINUATION_STATE_TOO_LARGE" | "INVALID_CONTINUATION_STATE" | "RALPH_MAX_REACHED" | "SCHEDULER_ERROR" | "SESSION_ERROR" | "TASK_ID_REQUIRED" | "TASK_MISSING_OUTPUT" | "TASK_EMPTY_PROMPT" | "WORKFLOW_RENDER_FAILED" | "DUPLICATE_ID" | "NESTED_LOOP" | "WORKTREE_EMPTY_PATH" | "MDX_PRELOAD_INACTIVE" | "CONTEXT_OUTSIDE_WORKFLOW" | "MISSING_OUTPUT" | "DEP_NOT_SATISFIED" | "ASPECT_BUDGET_EXCEEDED" | "APPROVAL_OUTSIDE_TASK" | "APPROVAL_OPTIONS_REQUIRED" | "WORKFLOW_MISSING_DEFAULT" | "WORKFLOW_NOT_BUILT" | "TOOL_PATH_INVALID" | "TOOL_PATH_ESCAPE" | "TOOL_FILE_TOO_LARGE" | "TOOL_CONTENT_TOO_LARGE" | "TOOL_PATCH_TOO_LARGE" | "TOOL_PATCH_FAILED" | "TOOL_NETWORK_DISABLED" | "TOOL_GIT_REMOTE_DISABLED" | "TOOL_COMMAND_FAILED" | "TOOL_GREP_FAILED" | "AGENT_CLI_ERROR" | "AGENT_CONFIG_INVALID" | "AGENT_QUOTA_EXCEEDED" | "AGENT_RPC_FILE_ARGS" | "AGENT_BUILD_COMMAND" | "AGENT_DIAGNOSTIC_TIMEOUT" | "ACCOUNT_INVALID" | "ACCOUNT_NOT_FOUND" | "ACCOUNT_DUPLICATE_LABEL" | "ACCOUNTS_FILE_INVALID" | "DB_MISSING_COLUMNS" | "DB_REQUIRES_BUN_SQLITE" | "DB_QUERY_FAILED" | "DB_WRITE_FAILED" | "SMITHERS_MIGRATION_REQUIRED" | "SMITHERS_BACKEND_CONFLICT" | "STORAGE_ERROR" | "INTERNAL_ERROR" | "PROCESS_ABORTED" | "PROCESS_TIMEOUT" | "PROCESS_IDLE_TIMEOUT" | "PROCESS_SPAWN_FAILED" | "TASK_RUNTIME_UNAVAILABLE" | "SCHEMA_CHANGE_HOT" | "HOT_OVERLAY_FAILED" | "HOT_RELOAD_INVALID_MODULE" | "SCORER_FAILED" | "WORKFLOW_EXISTS" | "CLI_DB_NOT_FOUND" | "CLI_AGENT_UNSUPPORTED" | "PI_HTTP_ERROR" | "EXTERNAL_BUILD_FAILED" | "SCHEMA_DISCOVERY_FAILED" | "OPENAPI_SPEC_LOAD_FAILED" | "OPENAPI_OPERATION_NOT_FOUND" | "OPENAPI_TOOL_EXECUTION_FAILED" | (string & {}))[] | undefined;
    __tcfCatchHandler: React__default.ReactElement<unknown, string | React__default.JSXElementConstructor<any>> | ((error: _smithers_orchestrator_errors.SmithersError) => React__default.ReactElement) | undefined;
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
 * `smithers-orchestrator/scorers` fold (`DelegationEvent[]` — the simulation
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
type AgentLike$1 = _smithers_orchestrator_agents_AgentLike.AgentLike;
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
 * `delegationRunScore` in `smithers-orchestrator/scorers`) and a `context`
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
 * colocated repo stays truthful — same probe shape as packages/vcs
 * `getJjPointer`, but on `commit_id` so `from..to` ranges work for both jj
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
type AgentLike = _smithers_orchestrator_agents_AgentLike.AgentLike;

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
type ScorersMap = _smithers_orchestrator_graph_types.ScorersMap;
type SequenceProps = SequenceProps$2;
type SidecarDelta = SidecarDelta$1;
type SidecarProps = SidecarProps$2;
type SignalProps<Schema> = SignalProps$2<Schema>;
type SourceDef = SourceDef$1;
type SubflowProps = SubflowProps$2;
type SuperSmithersProps = SuperSmithersProps$2;
type SupervisorProps = SupervisorProps$2;
type TaskProps<Row, Output, D> = TaskProps$2<Row, Output, D>;
type TimerProps = TimerProps$2;
type TryCatchFinallyProps = TryCatchFinallyProps$2;
type TUIProps = TUIProps$1;
type UIProps = UIProps$1;
type WorkflowViewBootProps = WorkflowViewBootProps$1;
type WorkflowViewProps = WorkflowViewProps$1;
type WaitForEventProps = WaitForEventProps$2;
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
type MDXContent = React.ComponentType<Record<string, any>>;

/** @typedef {import("zod").ZodObject<import("zod").ZodRawShape>} ZodObject */
/** @typedef {import("zod").ZodTypeAny} ZodTypeAny */
/**
 * @param {ZodObject} schema
 * @returns {string}
 */
declare function zodSchemaToJsonExample(schema: ZodObject): string;
type ZodObject = zod.ZodObject<zod.ZodRawShape>;

type CachePolicy<Ctx> = _smithers_orchestrator_scheduler_CachePolicy.CachePolicy<Ctx>;
type EngineDecision = _smithers_orchestrator_scheduler.EngineDecision;
type ExtractOptions = _smithers_orchestrator_graph.ExtractOptions;
type HostElement = _smithers_orchestrator_graph.HostElement;
type HostNode = _smithers_orchestrator_graph.HostNode;
type HostText = _smithers_orchestrator_graph.HostText;
type InferOutputEntry<T> = _smithers_orchestrator_driver_OutputAccessor.InferOutputEntry<T>;
type InferRow<TTable> = _smithers_orchestrator_driver_OutputAccessor.InferRow<TTable>;
type OutputAccessor<Schema> = _smithers_orchestrator_driver_OutputAccessor.OutputAccessor<Schema>;
type OutputKey = _smithers_orchestrator_driver_OutputKey.OutputKey;
type RenderContext = _smithers_orchestrator_scheduler.RenderContext;
type RetryPolicy = _smithers_orchestrator_scheduler_RetryPolicy.RetryPolicy;
type RunAuthContext = _smithers_orchestrator_driver_RunAuthContext.RunAuthContext;
type RunOptions = _smithers_orchestrator_driver.RunOptions;
type RunResult = _smithers_orchestrator_driver.RunResult;
type SchemaRegistryEntry = _smithers_orchestrator_db_SchemaRegistryEntry.SchemaRegistryEntry;
type SmithersAlertLabels = _smithers_orchestrator_scheduler_SmithersWorkflowOptions.SmithersAlertLabels;
type SmithersAlertPolicy = _smithers_orchestrator_scheduler_SmithersWorkflowOptions.SmithersAlertPolicy;
type SmithersAlertPolicyDefaults = _smithers_orchestrator_scheduler_SmithersWorkflowOptions.SmithersAlertPolicyDefaults;
type SmithersAlertPolicyRule = _smithers_orchestrator_scheduler_SmithersWorkflowOptions.SmithersAlertPolicyRule;
type SmithersAlertReaction = _smithers_orchestrator_scheduler_SmithersWorkflowOptions.SmithersAlertReaction;
type SmithersAlertReactionKind = _smithers_orchestrator_scheduler_SmithersWorkflowOptions.SmithersAlertReactionKind;
type SmithersAlertReactionRef = _smithers_orchestrator_scheduler_SmithersWorkflowOptions.SmithersAlertReactionRef;
type SmithersAlertSeverity = _smithers_orchestrator_scheduler_SmithersWorkflowOptions.SmithersAlertSeverity;
type SmithersCtx = _smithers_orchestrator_driver.SmithersCtx;
type SmithersErrorCode = _smithers_orchestrator_errors_SmithersErrorCode.SmithersErrorCode;
type SmithersWorkflow<Schema> = _smithers_orchestrator_driver_WorkflowDefinition.WorkflowDefinition<Schema>;
type SmithersWorkflowDriverOptions<Schema> = _smithers_orchestrator_driver_WorkflowDriverOptions.WorkflowDriverOptions<Schema>;
type SmithersWorkflowOptions = _smithers_orchestrator_scheduler.SmithersWorkflowOptions;
type TaskDescriptor = _smithers_orchestrator_graph.TaskDescriptor;
type WaitReason = _smithers_orchestrator_scheduler.WaitReason;
type WorkflowGraph = _smithers_orchestrator_graph.WorkflowGraph;
type WorkflowRuntime = _smithers_orchestrator_driver_workflow_types.WorkflowRuntime;
type WorkflowSession = _smithers_orchestrator_driver_workflow_types.WorkflowSession;
type XmlElement = _smithers_orchestrator_graph.XmlElement;
type XmlNode = _smithers_orchestrator_graph.XmlNode;
type XmlText = _smithers_orchestrator_graph.XmlText;

export { Approval, type ApprovalAutoApprove, type ApprovalDecision, ApprovalGate, type ApprovalGateProps, type ApprovalMode, type ApprovalOption, type ApprovalProps, type ApprovalRanking, type ApprovalRequest, type ApprovalSelection, Aspects, type AspectsProps, BackpressurePlanning, type BackpressurePlanningProps, Branch, type BranchProps, type CachePolicy, type CategoryConfig, type CheckConfig, CheckSuite, type CheckSuiteProps, ClassifyAndRoute, type ClassifyAndRouteProps, type ColumnDef, ContentPipeline, type ContentPipelineProps, type ContentPipelineStage, ContinueAsNew, type ContinueAsNewProps, DC_EDIT_SIGNAL, DC_SKIP_PREVIEW_SIGNAL, DEFAULT_TIER_ORDER, type DcApprovalRow, type DcBudgetRow, type DcDevPreviewRow, type DcEditRow, type DcExecRow, type DcForecastRow, type DcGatesRow, type DcGoalApprovalRow, type DcGoalRow, type DcPlanRow, type DcPollRow, type DcPreviewRow, type DcProbeRow, type DcQuestionRow, type DcReplanRow, type DcReviewRow, type DcScoreRow, type DcSkipRow, Debate, type DebateProps, type DecisionRule, DecisionTable, type DecisionTableProps, type DelegationAgents, type DelegationBudget, DelegationChain, type DelegationChainProps, DelegationEditListener, type DelegationEditListenerProps, DelegationExecution, type DelegationExecutionProps, type DelegationOutputs, DelegationPlanning, type DelegationPlanningProps, DelegationPreview, type DelegationPreviewProps, type DelegationScorers, DelegationScoring, type DelegationScoringProps, type DelegationSharedProps, type DepsSpec, DeriskLoop, type DeriskLoopProps, type DevPreviewKind, DriftDetector, type DriftDetectorProps, type EngineDecision, EscalationChain, type EscalationChainProps, type EscalationLevel, type Estimate, type ExtractOptions, type Gate, GatherAndSynthesize, type GatherAndSynthesizeProps, GoalRefinement, type GoalRefinementProps, type HostElement, type HostNode, type HostText, HumanTask, type HumanTaskProps, type InferDeps, type InferOutputEntry, type InferRow, Kanban, type KanbanProps, Loop, type LoopProps, MergeQueue, type MergeQueueProps, Optimizer, type OptimizerProps, type OutputAccessor, type OutputKey, type OutputTarget, Panel, type PanelProps, type PanelistConfig, Parallel, type ParallelProps, Poller, type PollerProps, Ralph, type RalphProps, type RenderContext, type RetryPolicy, ReviewLoop, type ReviewLoopProps, type RunAuthContext, type RunOptions, type RunResult, Runbook, type RunbookProps, type RunbookStep, SMITHERS_WORKFLOW_VIEW_KIND, Saga, type SagaProps, SagaStep, type SagaStepDef, type SagaStepProps, Sandbox, type SandboxEgressConfig, type SandboxProps, type SandboxRuntime, type SandboxVolumeMount, type SandboxWorkspaceSpec, ScanFixVerify, type ScanFixVerifyProps, type SchemaRegistryEntry, type ScorersMap, Sequence, type SequenceProps, Sidecar, type SidecarDelta, type SidecarProps, Signal, type SignalProps, type SmithersAlertLabels, type SmithersAlertPolicy, type SmithersAlertPolicyDefaults, type SmithersAlertPolicyRule, type SmithersAlertReaction, type SmithersAlertReactionKind, type SmithersAlertReactionRef, type SmithersAlertSeverity, type SmithersCtx, type SmithersErrorCode, type SmithersWorkflow, type SmithersWorkflowDriverOptions, type SmithersWorkflowOptions, type SourceDef, Subflow, type SubflowProps, SuperSmithers, type SuperSmithersProps, Supervisor, type SupervisorProps, TUI, type TUIProps, Task, type TaskDescriptor, type TaskProps, type Tier, Timer, type TimerProps, TryCatchFinally, type TryCatchFinallyProps, UI, type UIProps, WaitForEvent, type WaitForEventProps, type WaitReason, Workflow, type WorkflowGraph, type WorkflowProps, type WorkflowRuntime, type WorkflowSession, type WorkflowViewBootProps, type WorkflowViewProps, Worktree, type WorktreeProps, type XmlElement, type XmlNode, type XmlText, actualTotals, agentForTier, approvalDecisionSchema, approvalRankingSchema, approvalSelectionSchema, captureWorkingCopyCommit, chunkGateFailures, computeSidecarDelta, continueAsNew, dcApprovalSchema, dcBudgetSchema, dcDevPreviewSchema, dcEditSchema, dcExecSchema, dcForecastSchema, dcGatesSchema, dcGoalApprovalSchema, dcGoalSchema, dcPlanSchema, dcPollSchema, dcPreviewSchema, dcProbeSchema, dcQuestionSchema, dcReplanSchema, dcReviewSchema, dcScoreSchema, dcSkipSchema, delegationPrompts, delegationSchemas, dependentsOf, devPreviewKindSchema, devPreviewNodeId, estimateSchema, executionComplete, foldGates, foldPlans, frontierLeaves, gateSchema, leafAttemptState, leafComplete, leavesUnder, markdownComponents, nodeIndex, pendingTriggers, physicalId, planOwnerOf, planningComplete, probeIdFor, probesRequested, renderMdx, renderPromptToText, replanCountFor, splitGates, synthesizeDelegationEvents, tierSchema, triggerTargetOf, unplannedChunks, withCommitRange, zodSchemaToJsonExample };
