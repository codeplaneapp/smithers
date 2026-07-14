import { z } from 'zod';
import { ProofBinding } from './ProofBinding.js';

type XmlNode = XmlElement | XmlText;
type XmlElement = {
    readonly kind: "element";
    readonly tag: string;
    readonly props: Record<string, string>;
    readonly children: readonly XmlNode[];
};
type XmlText = {
    readonly kind: "text";
    readonly text: string;
};
type HostNode = HostElement | HostText;
type HostElement = {
    readonly kind: "element";
    readonly tag: string;
    readonly props: Record<string, string>;
    readonly rawProps: Record<string, unknown>;
    readonly children: readonly HostNode[];
};
type HostText = {
    readonly kind: "text";
    readonly text: string;
};
type RetryPolicy = {
    backoff?: "fixed" | "linear" | "exponential";
    initialDelayMs?: number;
};
type CachePolicy<Ctx = unknown> = {
    by?: (ctx: Ctx) => unknown;
    version?: string;
    key?: string;
    ttlMs?: number;
    scope?: "run" | "workflow" | "global";
    [key: string]: unknown;
};
type AgentLike = {
    id?: string;
    tools?: Record<string, unknown>;
    supportsNativeStructuredOutput?: boolean;
    capabilities?: {
        version: 1;
        engine: string;
        runtimeTools: Record<string, {
            description?: string;
            source?: string;
        }>;
        mcp: Record<string, unknown>;
        skills: Record<string, unknown>;
        humanInteraction: Record<string, unknown>;
        builtIns: string[];
    };
    generate: (args: unknown) => Promise<unknown>;
};
type ScoreResult = {
    score: number;
    reason?: string;
    meta?: Record<string, unknown>;
};
type ScorerInput = {
    input: unknown;
    output: unknown;
    groundTruth?: unknown;
    context?: unknown;
    latencyMs?: number;
    outputSchema?: z.ZodObject;
};
type ScorerFn = (input: ScorerInput) => Promise<ScoreResult>;
type Scorer = {
    id: string;
    name: string;
    description: string;
    score: ScorerFn;
};
type SamplingConfig = {
    type: "all";
} | {
    type: "ratio";
    rate: number;
} | {
    type: "none";
};
type ScorerBinding = {
    scorer: Scorer;
    sampling?: SamplingConfig;
};
type ScorersMap = Record<string, unknown>;
type MemoryNamespaceKind = "workflow" | "agent" | "user" | "global";
type MemoryNamespace = {
    kind: MemoryNamespaceKind;
    id: string;
};
type TaskMemoryConfig = {
    recall?: {
        namespace?: MemoryNamespace;
        query?: string;
        topK?: number;
    };
    remember?: {
        namespace?: MemoryNamespace;
        key?: string;
    };
    threadId?: string;
};
type ApprovalOption = {
    key: string;
    label: string;
    summary?: string;
    metadata?: Record<string, unknown>;
};
/**
 * Resolved `<Aspects>` budget configuration that applies to a task, extracted
 * from the `__aspects` element prop. The engine reads this at task-dispatch
 * time to enforce per-run token and latency budgets. The render-time
 * accumulator carried alongside the budgets in the component tree is dropped
 * here; the engine keeps its own durable accumulator.
 */
type TaskAspects = {
    tokenBudget?: {
        max: number;
        perTask?: number;
        onExceeded?: "fail" | "warn" | "skip-remaining";
    };
    latencySlo?: {
        maxMs: number;
        perTask?: number;
        onExceeded?: "fail" | "warn";
    };
};
type TaskDescriptor = {
    nodeId: string;
    ordinal: number;
    iteration: number;
    kind?: "agent" | "compute" | "static" | "human";
    ralphId?: string;
    dependsOn?: string[];
    needs?: Record<string, string>;
    /** True when the JSX task declared `bind`, including `bind={undefined}`. */
    proofBindingRequired?: boolean;
    /** Content-addressed authority rows pinned for this task execution. */
    proofBindings?: readonly ProofBinding[];
    /** Engine-computed result of the schedule-time binding verification. */
    proofBindingStatus?: "current" | "missing" | "stale";
    /** Logical id of the task whose final agent session this task forks. Gates execution and seeds the session. */
    forkSource?: string;
    worktreeId?: string;
    worktreePath?: string;
    worktreeBranch?: string;
    worktreeBaseBranch?: string;
    outputTable: unknown | null;
    outputTableName: string;
    outputRef?: z.ZodObject;
    outputSchema?: z.ZodObject;
    parallelGroupId?: string;
    parallelMaxConcurrency?: number;
    /** Stable id of the nearest ancestor `<Parallel subtreeConcurrency>` group this task belongs to. */
    subtreeGroupId?: string;
    /** Stable key of that parallel's direct child this task descends from (explicit key/id, else child ordinal). */
    subtreeChildKey?: string;
    /** Max direct-child subtrees of the subtree group allowed in flight at once. */
    subtreeMax?: number;
    /**
     * Scheduling priority (default 0). When more tasks are runnable than free
     * concurrency slots, higher-priority tasks claim slots first; equal
     * priorities keep plan order. Never overrides dependencies or group caps.
     * Inherited from the nearest `<Parallel>`/`<MergeQueue>` ancestor that sets
     * one unless the node sets its own.
     */
    priority?: number;
    /** Failure handling inherited from the nearest declarative container. */
    failurePolicy?: "halt" | "quarantine";
    needsApproval: boolean;
    waitAsync?: boolean;
    approvalMode?: "gate" | "decision" | "select" | "rank";
    approvalOnDeny?: "fail" | "continue" | "skip";
    approvalOptions?: ApprovalOption[];
    approvalAllowedScopes?: string[];
    approvalAllowedUsers?: string[];
    approvalAutoApprove?: {
        after?: number;
        audit?: boolean;
        conditionMet?: boolean;
        revertOnMet?: boolean;
    };
    skipIf: boolean;
    retries: number;
    retryPolicy?: RetryPolicy;
    timeoutMs: number | null;
    heartbeatTimeoutMs: number | null;
    continueOnFail: boolean;
    cachePolicy?: CachePolicy;
    hijack?: boolean;
    onHijackExit?: "complete" | "reopen";
    agent?: AgentLike | AgentLike[];
    prompt?: string;
    staticPayload?: unknown;
    computeFn?: () => unknown | Promise<unknown>;
    label?: string;
    meta?: Record<string, unknown>;
    scorers?: ScorersMap;
    groundTruth?: unknown;
    context?: unknown;
    memoryConfig?: TaskMemoryConfig;
    /** Resolved `<Aspects>` budget configuration enforced by the engine at dispatch. */
    aspects?: TaskAspects;
};
type WorkflowGraph = {
    readonly xml: XmlNode | null;
    readonly tasks: readonly TaskDescriptor[];
    readonly mountedTaskIds: readonly string[];
};
type GraphSnapshot = {
    readonly runId: string;
    readonly frameNo: number;
    readonly xml: XmlNode | null;
    readonly tasks: readonly TaskDescriptor[];
};
type ExtractOptions = {
    readonly ralphIterations?: ReadonlyMap<string, number> | Record<string, number>;
    readonly defaultIteration?: number;
    readonly baseRootDir?: string;
    readonly workflowPath?: string | null;
    readonly trigger?: unknown;
    /**
     * Resolves a `<Worktree path>` prop. `extractGraph` never imports a
     * concrete resolver itself (that would statically pull a Node-only path
     * resolver into any bundle importing this module) — callers that may
     * render a `<Worktree>` must supply one (Node: the real
     * `resolveWorktreePath` from `./worktree-path.js`; other runtimes: their
     * `RuntimeAdapter`'s `worktree.resolve`). Extraction throws a typed
     * `RUNTIME_CAPABILITY_UNAVAILABLE` error if a `<Worktree>` is encountered
     * and no resolver was provided.
     */
    readonly resolveWorktreePath?: (path: string, opts?: {
        baseRootDir?: string;
        workflowPath?: string | null;
    }) => string;
};
type ExtractGraph = (root: HostNode | null, opts?: ExtractOptions) => WorkflowGraph | Promise<WorkflowGraph>;

export type { AgentLike, ApprovalOption, CachePolicy, ExtractGraph, ExtractOptions, GraphSnapshot, HostElement, HostNode, HostText, MemoryNamespace, MemoryNamespaceKind, RetryPolicy, SamplingConfig, ScoreResult, Scorer, ScorerBinding, ScorerFn, ScorerInput, ScorersMap, TaskAspects, TaskDescriptor, TaskMemoryConfig, WorkflowGraph, XmlElement, XmlNode, XmlText };
