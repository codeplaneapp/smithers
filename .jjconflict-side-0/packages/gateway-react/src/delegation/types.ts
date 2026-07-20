/**
 * UI-facing types for the delegation-chain folded state (the flux store the
 * `delegation-chain` workflow UIs render from). These mirror the frozen build
 * contract; the zod row schemas live in `packages/components` — this module is
 * plain TypeScript plus the narrow runtime guards `foldDelegation` uses to
 * tolerate malformed rows without throwing.
 */

export type Tier = "fable" | "opus" | "sonnet" | "haiku";

export const DELEGATION_TIERS: readonly Tier[] = ["fable", "opus", "sonnet", "haiku"];

/**
 * The five developer-preview flavors a `preview` gate / `dcDevPreview` row can
 * carry: `app` = the built thing itself (or a UI rendering it), `terminal` =
 * a rendered terminal + instructions for driving a CLI, `api` = an explorer
 * UI for a built API, `throwaway-ui` = a disposable UI over the work,
 * `slideshow` = an HTML slideshow of what was done (the no-runnable-code
 * fallback).
 */
export type DevPreviewKind = "app" | "terminal" | "api" | "throwaway-ui" | "slideshow";

const DEV_PREVIEW_KINDS: readonly DevPreviewKind[] = ["app", "terminal", "api", "throwaway-ui", "slideshow"];

export type Gate =
  | { method: "review"; tier: Tier; brief: string }
  | { method: "check"; command: string }
  | { method: "approval"; policyMatch: string }
  /**
   * Developer preview: post-execution backpressure. A successful build
   * (`dcDevPreview.builtOk`) is REQUIRED for the node to pass; the rendered
   * artifact carries user invalidate / request-changes affordances in the UI
   * (which emit `dc-edit` rounds).
   */
  | { method: "preview"; kind: DevPreviewKind; brief: string };

/** Predicted (or measured) resource envelope for a node/subtree. */
export type Estimate = { tokens: number; costUsd: number; minutes: number };

export type DcGoalRow = {
  logicalId: string;
  refinedPrompt: string;
  assumptions: string[];
  questionsAsked: number;
};

export type DcQuestionRow = {
  logicalId: string;
  seq: number;
  question: string;
  header: string;
  kind: "select" | "confirm" | "text";
  options?: Array<{ label: string; description: string }>;
  recommended: string;
  reason: string;
  resolved: boolean;
};

export type DcPlanChild = {
  logicalId: string;
  tier: Tier;
  kind: "chunk" | "leaf";
  title: string;
  brief: string;
  estimate: Estimate;
};

export type DcPlanRisk = {
  id: string;
  description: string;
  /** `null` means "considered, judged routine" — that judgment is scored. */
  probe: "poc" | "research" | null;
  reason: string;
};

export type DcPlanRow = {
  logicalId: string;
  tier: Tier;
  title: string;
  brief: string;
  children: DcPlanChild[];
  subtreeEstimate: Estimate;
  risks: DcPlanRisk[];
  // v2 higher-order orchestration: reserved. "workflow" will mean the node's
  // execution strategy is an agent-AUTHORED smithers workflow (mounted as a
  // <Subflow>) instead of task subtrees. Accepted and ignored today — it must
  // never trip malformed-row tolerance.
  orchestration?: "tasks" | "workflow";
};

export type DcPreviewRow = {
  logicalId: string;
  /** Markdown/pseudocode — ALWAYS shown with a "never executed" warning. */
  expectedOutput: string;
};

export type DcGatesRow = {
  logicalId: string;
  gates: Gate[];
  depsLogical: string[];
};

/**
 * Developer-preview build result (physical node phase `dev-preview`,
 * `dc:<logicalId>:dev-preview`). `builtOk: false` fails the gate like a
 * failed review — the node is redelegated with the failure folded in.
 */
export type DcDevPreviewRow = {
  logicalId: string;
  kind: DevPreviewKind;
  title: string;
  builtOk: boolean;
  artifact: { type: "html" | "url" | "markdown"; content?: string; url?: string };
  instructions?: string;
  summary: string;
};

export type DcProbeRow = {
  probeId: string;
  parentLogicalId: string;
  kind: "poc" | "research";
  question: string;
  answer: string;
  /** Well-sourced markdown; delivered to the NEAREST PARENT only. */
  report: string;
  planImpact: "changes" | "confirms" | "none";
  proposedChange?: string;
};

export type DcReplanRow = {
  round: number;
  logicalId: string;
  decision: "invalidated" | "reaffirmed";
  reason: string;
  trigger: { type: "probe" | "user-edit" | "review-fail"; ref: string };
};

export type DcExecRow = {
  logicalId: string;
  attempt: number;
  summary: string;
  artifacts: string[];
  /** Best-effort measured usage from engine data, where available. */
  actual?: Partial<Estimate>;
  /** The VCS commits this attempt produced; reviews use it to inspect the work. */
  commitRange?: { from: string; to: string; vcs: "jj" | "git" };
};

export type DcReviewRow = {
  logicalId: string;
  attempt: number;
  verdict: "pass" | "fail";
  feedback: string;
};

/** Signal payload delivered on correlation key `dc-edit`. */
export type DcEditRow = {
  editId: string;
  logicalId: string;
  editedOutput: unknown;
  note?: string;
};

/** Signal payload delivered on correlation key `dc-skip-preview`. */
export type DcSkipRow = { skipped: true };

export type DcPollAnswer = { question: string; rating: 1 | 2 | 3 | 4 | 5 };

/** HumanTask json-form payload for the end-of-run poll. */
export type DcPollRow = { answers: DcPollAnswer[]; comment?: string };

/**
 * One durable row the reducer folds: `table` names the output table the row
 * was written to, `nodeId` is the PHYSICAL smithers node id
 * (`dc:<logicalId>:<phase>`), `iteration` is the loop/retry attempt of that
 * physical node, and `row` is the untrusted row payload (validated by the
 * guards below). `seq` is an optional global ordering hint (gateway event
 * seq); the fold stays deterministic without it.
 */
export type DelegationOutputRecord = {
  table: string;
  nodeId: string;
  iteration: number;
  row: unknown;
  seq?: number;
};

/** Pending-human marker for a physical node (from the approvals surface). */
export type DelegationApprovalRecord = {
  table: "_approval";
  nodeId: string;
  iteration?: number;
  pending: boolean;
  seq?: number;
};

export type DelegationRecord = DelegationOutputRecord | DelegationApprovalRecord;

export type DelegationNodeKind = "goal" | "chunk" | "leaf" | "poc" | "research" | "score";

export type DelegationNodeStatus =
  | "planned"
  | "previewing"
  | "derisking"
  | "ready"
  | "running"
  | "awaiting-human"
  | "invalidated"
  | "done"
  | "failed";

/**
 * One archived (or current) version of a node. Version bumps happen on
 * plan-level invalidations ONLY (`dcReplan` decision `"invalidated"`); review
 * failures retry as new attempts WITHIN a version. The current version is the
 * last entry (no `invalidatedBy`); every prior entry carries the `dcReplan`
 * row that killed it.
 */
export type DelegationVersionSnapshot = {
  version: number;
  plan?: DcPlanRow;
  gates?: DcGatesRow;
  exec?: DcExecRow[];
  review?: DcReviewRow[];
  invalidatedBy?: DcReplanRow;
};

export type DelegationNodeState = {
  logicalId: string;
  parentId: string | null;
  tier: Tier;
  kind: DelegationNodeKind;
  title: string;
  brief: string;
  status: DelegationNodeStatus;
  /** Current version number (1-based). */
  version: number;
  versions: DelegationVersionSnapshot[];
  deps: string[];
  gates: Gate[];
  preview?: string;
  /** Latest developer-preview build for the current version. */
  devPreview?: DcDevPreviewRow;
  output?: unknown;
  /** Latest prediction for this node/subtree — replans supersede. */
  estimate?: Estimate;
  /** Rolled-up actuals so far (self + descendants' `dcExec.actual`). */
  actual?: Partial<Estimate>;
  /** Pending-human rollup: `self` for this node, `descendants` counts strict descendants. */
  attention: { self: boolean; descendants: number };
};

export type DelegationEdge = {
  from: string;
  to: string;
  kind: "child" | "dep" | "gate" | "probe";
};

export type DelegationPhase =
  | "goal"
  | "planning"
  | "preview"
  | "gates"
  | "derisk"
  | "execution"
  | "scoring"
  | "done";

export type DelegationGraph = {
  nodes: Record<string, DelegationNodeState>;
  rootId: string | null;
  edges: DelegationEdge[];
  phase: DelegationPhase;
  pendingQuestions: DcQuestionRow[];
  refinedPrompt?: string;
  /**
   * Run-level rollup: `predicted` uses the LATEST plan/replan estimates (a
   * child's own re-forecast supersedes its parent's stale estimate for it);
   * `actual` sums every reported `dcExec.actual`. Drives the
   * "$actual of $latestPredicted" progress bar.
   */
  budget: { predicted: Estimate | null; actual: Partial<Estimate> };
  scores?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Narrow runtime guards. Guards accept extra fields and only demand the shape
// the fold actually reads, so schema evolution on the writer side does not
// silently drop rows here.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function isTier(value: unknown): value is Tier {
  return (DELEGATION_TIERS as readonly string[]).includes(value as string);
}

export function isEstimate(value: unknown): value is Estimate {
  return (
    isRecord(value) &&
    typeof value.tokens === "number" && Number.isFinite(value.tokens) &&
    typeof value.costUsd === "number" && Number.isFinite(value.costUsd) &&
    typeof value.minutes === "number" && Number.isFinite(value.minutes)
  );
}

export function isDevPreviewKind(value: unknown): value is DevPreviewKind {
  return (DEV_PREVIEW_KINDS as readonly string[]).includes(value as string);
}

export function isGate(value: unknown): value is Gate {
  if (!isRecord(value)) return false;
  if (value.method === "review") return isTier(value.tier) && typeof value.brief === "string";
  if (value.method === "check") return typeof value.command === "string";
  if (value.method === "approval") return typeof value.policyMatch === "string";
  if (value.method === "preview") return isDevPreviewKind(value.kind) && typeof value.brief === "string";
  return false;
}

export function isDcGoalRow(value: unknown): value is DcGoalRow {
  return (
    isRecord(value) &&
    typeof value.logicalId === "string" &&
    typeof value.refinedPrompt === "string" &&
    isStringArray(value.assumptions) &&
    typeof value.questionsAsked === "number"
  );
}

export function isDcQuestionRow(value: unknown): value is DcQuestionRow {
  return (
    isRecord(value) &&
    typeof value.logicalId === "string" &&
    typeof value.seq === "number" &&
    typeof value.question === "string" &&
    typeof value.header === "string" &&
    (value.kind === "select" || value.kind === "confirm" || value.kind === "text") &&
    typeof value.recommended === "string" &&
    typeof value.reason === "string" &&
    typeof value.resolved === "boolean"
  );
}

export function isDcPlanChild(value: unknown): value is DcPlanChild {
  return (
    isRecord(value) &&
    typeof value.logicalId === "string" &&
    isTier(value.tier) &&
    (value.kind === "chunk" || value.kind === "leaf") &&
    typeof value.title === "string" &&
    typeof value.brief === "string" &&
    isEstimate(value.estimate)
  );
}

export function isDcPlanRow(value: unknown): value is DcPlanRow {
  return (
    isRecord(value) &&
    typeof value.logicalId === "string" &&
    isTier(value.tier) &&
    typeof value.title === "string" &&
    typeof value.brief === "string" &&
    Array.isArray(value.children) && value.children.every(isDcPlanChild) &&
    isEstimate(value.subtreeEstimate) &&
    Array.isArray(value.risks) &&
    value.risks.every(
      (risk) =>
        isRecord(risk) &&
        typeof risk.id === "string" &&
        typeof risk.description === "string" &&
        (risk.probe === "poc" || risk.probe === "research" || risk.probe === null) &&
        typeof risk.reason === "string",
    )
  );
}

export function isDcPreviewRow(value: unknown): value is DcPreviewRow {
  return isRecord(value) && typeof value.logicalId === "string" && typeof value.expectedOutput === "string";
}

export function isDcGatesRow(value: unknown): value is DcGatesRow {
  return (
    isRecord(value) &&
    typeof value.logicalId === "string" &&
    Array.isArray(value.gates) && value.gates.every(isGate) &&
    isStringArray(value.depsLogical)
  );
}

export function isDcDevPreviewRow(value: unknown): value is DcDevPreviewRow {
  return (
    isRecord(value) &&
    typeof value.logicalId === "string" &&
    isDevPreviewKind(value.kind) &&
    typeof value.title === "string" &&
    typeof value.builtOk === "boolean" &&
    isRecord(value.artifact) &&
    (value.artifact.type === "html" || value.artifact.type === "url" || value.artifact.type === "markdown") &&
    (value.artifact.content === undefined || typeof value.artifact.content === "string") &&
    (value.artifact.url === undefined || typeof value.artifact.url === "string") &&
    (value.instructions === undefined || typeof value.instructions === "string") &&
    typeof value.summary === "string"
  );
}

export function isDcProbeRow(value: unknown): value is DcProbeRow {
  return (
    isRecord(value) &&
    typeof value.probeId === "string" &&
    typeof value.parentLogicalId === "string" &&
    (value.kind === "poc" || value.kind === "research") &&
    typeof value.question === "string" &&
    typeof value.answer === "string" &&
    typeof value.report === "string" &&
    (value.planImpact === "changes" || value.planImpact === "confirms" || value.planImpact === "none")
  );
}

export function isDcReplanRow(value: unknown): value is DcReplanRow {
  return (
    isRecord(value) &&
    typeof value.round === "number" &&
    typeof value.logicalId === "string" &&
    (value.decision === "invalidated" || value.decision === "reaffirmed") &&
    typeof value.reason === "string" &&
    isRecord(value.trigger) &&
    (value.trigger.type === "probe" || value.trigger.type === "user-edit" || value.trigger.type === "review-fail") &&
    typeof value.trigger.ref === "string"
  );
}

export function isDcExecRow(value: unknown): value is DcExecRow {
  return (
    isRecord(value) &&
    typeof value.logicalId === "string" &&
    typeof value.attempt === "number" &&
    typeof value.summary === "string" &&
    isStringArray(value.artifacts) &&
    (value.actual === undefined || isRecord(value.actual)) &&
    (value.commitRange === undefined ||
      (isRecord(value.commitRange) &&
        typeof value.commitRange.from === "string" &&
        typeof value.commitRange.to === "string" &&
        (value.commitRange.vcs === "jj" || value.commitRange.vcs === "git")))
  );
}

export function isDcReviewRow(value: unknown): value is DcReviewRow {
  return (
    isRecord(value) &&
    typeof value.logicalId === "string" &&
    typeof value.attempt === "number" &&
    (value.verdict === "pass" || value.verdict === "fail") &&
    typeof value.feedback === "string"
  );
}

export function isDcEditRow(value: unknown): value is DcEditRow {
  return isRecord(value) && typeof value.editId === "string" && typeof value.logicalId === "string" && "editedOutput" in value;
}

export function isDcSkipRow(value: unknown): value is DcSkipRow {
  return isRecord(value) && value.skipped === true;
}

export function isDcPollRow(value: unknown): value is DcPollRow {
  return (
    isRecord(value) &&
    Array.isArray(value.answers) &&
    value.answers.every(
      (answer) =>
        isRecord(answer) &&
        typeof answer.question === "string" &&
        typeof answer.rating === "number" && answer.rating >= 1 && answer.rating <= 5,
    )
  );
}

export function isDelegationApprovalRecord(record: DelegationRecord): record is DelegationApprovalRecord {
  return record.table === "_approval" && typeof (record as DelegationApprovalRecord).pending === "boolean";
}
