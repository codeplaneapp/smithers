/**
 * Pure, non-React reducer that folds durable delegation rows into the
 * `DelegationGraph` flux state the UI renders. Deterministic and
 * order-insensitive: records are sorted internally by
 * (table-priority, iteration, intrinsic row seq, seq, row identity), and the
 * fold itself is structural (versions, cascades, and rollups are derived from
 * the full record set, not from arrival order), so shuffling the input yields
 * a deep-equal graph.
 *
 * Tolerance: unknown tables are ignored; malformed rows are reported through
 * `options.onIgnored` and skipped — the reducer never throws on bad data.
 */

import type {
  DcDevPreviewRow,
  DcEditRow,
  DcExecRow,
  DcGatesRow,
  DcGoalRow,
  DcPlanChild,
  DcPlanRow,
  DcPreviewRow,
  DcProbeRow,
  DcQuestionRow,
  DcReplanRow,
  DcReviewRow,
  DelegationEdge,
  DelegationGraph,
  DelegationNodeKind,
  DelegationNodeState,
  DelegationNodeStatus,
  DelegationPhase,
  DelegationRecord,
  DelegationVersionSnapshot,
  Estimate,
  Gate,
  Tier,
} from "./types.ts";
import {
  isDcDevPreviewRow,
  isDcEditRow,
  isDcExecRow,
  isDcGatesRow,
  isDcGoalRow,
  isDcPlanRow,
  isDcPollRow,
  isDcPreviewRow,
  isDcProbeRow,
  isDcQuestionRow,
  isDcReplanRow,
  isDcReviewRow,
  isDcSkipRow,
  isDelegationApprovalRecord,
} from "./types.ts";

export type DelegationFoldIssue = {
  record: DelegationRecord;
  reason: "unknown-table" | "malformed-row";
};

export type FoldDelegationOptions = {
  /** Called for every ignored record (unknown table / malformed row). */
  onIgnored?: (issue: DelegationFoldIssue) => void;
};

/** Phase-ordered table priority — the sort key's leading component. */
const TABLE_PRIORITY: Record<string, number> = {
  dcGoal: 0,
  dcQuestion: 1,
  dcPlan: 2,
  dcPreview: 3,
  dcGates: 4,
  dcProbe: 5,
  dcEdit: 6,
  dcReplan: 7,
  dcExec: 8,
  dcReview: 9,
  dcDevPreview: 10,
  dcSkip: 11,
  dcPoll: 12,
  dcScore: 13,
  _approval: 14,
};

const PHASE_SUFFIX_TO_TABLE: Record<string, string> = {
  goal: "dcGoal",
  question: "dcQuestion",
  plan: "dcPlan",
  preview: "dcPreview",
  gates: "dcGates",
  probe: "dcProbe",
  replan: "dcReplan",
  exec: "dcExec",
  review: "dcReview",
  "dev-preview": "dcDevPreview",
  poll: "dcPoll",
  score: "dcScore",
};

/**
 * Parse a physical delegation node id (`dc:<logicalId>:<phase>`) into its
 * logical id and phase. Returns null for anything that is not a delegation
 * node id.
 */
export function parseDelegationNodeId(nodeId: string): { logicalId: string; phase: string } | null {
  const parts = nodeId.split(":");
  if (parts.length < 3 || parts[0] !== "dc") return null;
  const phase = parts[parts.length - 1]!;
  // Gateway node ids forbid `/`, so emitters encode logical `/` as `:`
  // (components `physicalId()`); decode by re-joining with `/`. Ids that
  // somehow carry a literal `/` inside one segment decode identically.
  const logicalId = parts.slice(1, -1).join("/");
  if (!logicalId || !phase) return null;
  if (PHASE_SUFFIX_TO_TABLE[phase.replace(/-\d+$/, "")] === undefined) return null;
  return { logicalId, phase };
}

/**
 * The output table a physical delegation node writes to, derived from the
 * `dc:<logicalId>:<phase>` naming contract (plus the signal/poll listener
 * node ids `dc-edit` / `dc-skip-preview` / `dc-poll`). Null when the node is
 * not part of a delegation chain.
 */
export function delegationTableForNodeId(nodeId: string): string | null {
  if (nodeId === "dc-edit") return "dcEdit";
  if (nodeId === "dc-skip-preview") return "dcSkip";
  if (nodeId === "dc-poll") return "dcPoll";
  const parsed = parseDelegationNodeId(nodeId);
  if (!parsed) return null;
  return PHASE_SUFFIX_TO_TABLE[parsed.phase.replace(/-\d+$/, "")] ?? null;
}

// ---------------------------------------------------------------------------
// Deterministic ordering
// ---------------------------------------------------------------------------

/** JSON.stringify with sorted object keys, so equal rows stringify equally. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

/** A row-intrinsic sequence (question seq / replan round / exec attempt). */
function intrinsicSeq(table: string, row: unknown): number {
  if (typeof row !== "object" || row === null) return 0;
  const record = row as Record<string, unknown>;
  const pick =
    table === "dcQuestion" ? record.seq :
    table === "dcReplan" ? record.round :
    table === "dcExec" || table === "dcReview" ? record.attempt :
    0;
  return typeof pick === "number" && Number.isFinite(pick) ? pick : 0;
}

function compareRecords(left: DelegationRecord, right: DelegationRecord): number {
  const table = (TABLE_PRIORITY[left.table] ?? 99) - (TABLE_PRIORITY[right.table] ?? 99);
  if (table !== 0) return table;
  const iteration = ((left as { iteration?: number }).iteration ?? 0) - ((right as { iteration?: number }).iteration ?? 0);
  if (iteration !== 0) return iteration;
  const leftRow = (left as { row?: unknown }).row;
  const rightRow = (right as { row?: unknown }).row;
  const intrinsic = intrinsicSeq(left.table, leftRow) - intrinsicSeq(right.table, rightRow);
  if (intrinsic !== 0) return intrinsic;
  const seq = (left.seq ?? 0) - (right.seq ?? 0);
  if (seq !== 0) return seq;
  const node = left.nodeId.localeCompare(right.nodeId);
  if (node !== 0) return node;
  return stableStringify(leftRow).localeCompare(stableStringify(rightRow));
}

// ---------------------------------------------------------------------------
// Estimate arithmetic
// ---------------------------------------------------------------------------

const ESTIMATE_FIELDS = ["tokens", "costUsd", "minutes"] as const;

function addEstimates(left: Estimate, right: Estimate): Estimate {
  return {
    tokens: left.tokens + right.tokens,
    costUsd: left.costUsd + right.costUsd,
    minutes: left.minutes + right.minutes,
  };
}

function subtractClamped(left: Estimate, right: Estimate): Estimate {
  return {
    tokens: Math.max(0, left.tokens - right.tokens),
    costUsd: Math.max(0, left.costUsd - right.costUsd),
    minutes: Math.max(0, left.minutes - right.minutes),
  };
}

const ZERO_ESTIMATE: Estimate = { tokens: 0, costUsd: 0, minutes: 0 };

function addPartial(left: Partial<Estimate>, right: Partial<Estimate>): Partial<Estimate> {
  const out: Partial<Estimate> = { ...left };
  for (const field of ESTIMATE_FIELDS) {
    const value = right[field];
    if (typeof value === "number" && Number.isFinite(value)) {
      out[field] = (out[field] ?? 0) + value;
    }
  }
  return out;
}

function hasAnyField(partial: Partial<Estimate>): boolean {
  return ESTIMATE_FIELDS.some((field) => partial[field] !== undefined);
}

// ---------------------------------------------------------------------------
// The fold
// ---------------------------------------------------------------------------

type InternalNode = {
  logicalId: string;
  parentId: string | null;
  declared?: DcPlanChild;
  /** How many parent plan rows have (re-)declared this node as a child. */
  declarationCount: number;
  planRows: DcPlanRow[];
  gatesRows: DcGatesRow[];
  execRows: DcExecRow[];
  reviewRows: DcReviewRow[];
  /** Developer-preview builds; the record iteration is the attempt marker. */
  devPreviews: Array<{ row: DcDevPreviewRow; iteration: number }>;
  previewRow?: DcPreviewRow;
  probeRow?: DcProbeRow;
  goalRow?: DcGoalRow;
  isGoal: boolean;
  invalidations: DcReplanRow[];
  reaffirms: DcReplanRow[];
  edits: DcEditRow[];
  approvalPending: boolean;
  /** Highest unresolved invalidation-cascade round that hit this node. */
  cascadeRound?: number;
};

function lastOf<T>(items: readonly T[]): T | undefined {
  return items.length ? items[items.length - 1] : undefined;
}

export function foldDelegation(records: DelegationRecord[], options: FoldDelegationOptions = {}): DelegationGraph {
  const ignore = (record: DelegationRecord, reason: DelegationFoldIssue["reason"]) => {
    options.onIgnored?.({ record, reason });
  };

  const sorted = [...records].sort(compareRecords);

  const nodes = new Map<string, InternalNode>();
  const ensure = (logicalId: string): InternalNode => {
    let node = nodes.get(logicalId);
    if (!node) {
      node = {
        logicalId,
        parentId: null,
        declarationCount: 0,
        planRows: [],
        gatesRows: [],
        execRows: [],
        reviewRows: [],
        devPreviews: [],
        isGoal: false,
        invalidations: [],
        reaffirms: [],
        edits: [],
        approvalPending: false,
      };
      nodes.set(logicalId, node);
    }
    return node;
  };

  const questionsByKey = new Map<string, DcQuestionRow>();
  const scores: Record<string, unknown> = {};
  const approvalByKey = new Map<string, boolean>();
  let refinedPrompt: string | undefined;
  let previewsSkipped = false;
  let pollSubmitted = false;

  for (const record of sorted) {
    if (record.table === "_approval") {
      if (!isDelegationApprovalRecord(record)) {
        ignore(record, "malformed-row");
        continue;
      }
      approvalByKey.set(`${record.nodeId} ${record.iteration ?? 0}`, record.pending);
      continue;
    }
    const priority = TABLE_PRIORITY[record.table];
    if (priority === undefined) {
      ignore(record, "unknown-table");
      continue;
    }
    const row = (record as { row?: unknown }).row;
    switch (record.table) {
      case "dcGoal": {
        if (!isDcGoalRow(row)) { ignore(record, "malformed-row"); break; }
        const node = ensure(row.logicalId);
        node.isGoal = true;
        node.goalRow = row;
        refinedPrompt = row.refinedPrompt;
        break;
      }
      case "dcQuestion": {
        if (!isDcQuestionRow(row)) { ignore(record, "malformed-row"); break; }
        ensure(row.logicalId).isGoal = true;
        questionsByKey.set(`${row.logicalId} ${row.seq}`, row);
        break;
      }
      case "dcPlan": {
        if (!isDcPlanRow(row)) { ignore(record, "malformed-row"); break; }
        const node = ensure(row.logicalId);
        node.planRows.push(row);
        for (const child of row.children) {
          const childNode = ensure(child.logicalId);
          childNode.parentId = row.logicalId;
          childNode.declared = child;
          childNode.declarationCount += 1;
        }
        break;
      }
      case "dcPreview": {
        if (!isDcPreviewRow(row)) { ignore(record, "malformed-row"); break; }
        ensure(row.logicalId).previewRow = row;
        break;
      }
      case "dcGates": {
        if (!isDcGatesRow(row)) { ignore(record, "malformed-row"); break; }
        ensure(row.logicalId).gatesRows.push(row);
        break;
      }
      case "dcProbe": {
        if (!isDcProbeRow(row)) { ignore(record, "malformed-row"); break; }
        const node = ensure(row.probeId);
        node.probeRow = row;
        node.parentId = row.parentLogicalId;
        ensure(row.parentLogicalId);
        break;
      }
      case "dcReplan": {
        if (!isDcReplanRow(row)) { ignore(record, "malformed-row"); break; }
        const node = ensure(row.logicalId);
        (row.decision === "invalidated" ? node.invalidations : node.reaffirms).push(row);
        break;
      }
      case "dcExec": {
        if (!isDcExecRow(row)) { ignore(record, "malformed-row"); break; }
        ensure(row.logicalId).execRows.push(row);
        break;
      }
      case "dcReview": {
        if (!isDcReviewRow(row)) { ignore(record, "malformed-row"); break; }
        ensure(row.logicalId).reviewRows.push(row);
        break;
      }
      case "dcDevPreview": {
        if (!isDcDevPreviewRow(row)) { ignore(record, "malformed-row"); break; }
        ensure(row.logicalId).devPreviews.push({ row, iteration: record.iteration });
        break;
      }
      case "dcEdit": {
        if (!isDcEditRow(row)) { ignore(record, "malformed-row"); break; }
        ensure(row.logicalId).edits.push(row);
        break;
      }
      case "dcSkip": {
        if (!isDcSkipRow(row)) { ignore(record, "malformed-row"); break; }
        previewsSkipped = true;
        break;
      }
      case "dcPoll": {
        if (!isDcPollRow(row)) { ignore(record, "malformed-row"); break; }
        pollSubmitted = true;
        break;
      }
      case "dcScore": {
        const key =
          typeof row === "object" && row !== null && typeof (row as Record<string, unknown>).logicalId === "string"
            ? ((row as Record<string, unknown>).logicalId as string)
            : record.nodeId;
        scores[key] = row;
        break;
      }
      default:
        ignore(record, "unknown-table");
    }
  }

  // Pending-approval flags: dedupe latest-per-(nodeId, iteration), then map
  // physical node ids onto logical nodes.
  for (const [key, pending] of approvalByKey) {
    if (!pending) continue;
    const nodeId = key.split(" ")[0]!;
    const parsed = parseDelegationNodeId(nodeId);
    if (!parsed) continue;
    ensure(parsed.logicalId).approvalPending = true;
  }

  // Keep bucket ordering canonical regardless of table interleaving.
  for (const node of nodes.values()) {
    node.invalidations.sort((a, b) => a.round - b.round);
    node.reaffirms.sort((a, b) => a.round - b.round);
    node.execRows.sort((a, b) => a.attempt - b.attempt);
    node.reviewRows.sort((a, b) => a.attempt - b.attempt);
    node.devPreviews.sort((a, b) => a.iteration - b.iteration);
  }

  // -------------------------------------------------------------------------
  // Invalidation cascade: dependents of an invalidated node (via child AND
  // dep/gate edges, transitively) downgrade to "derisking" until a reaffirm
  // or a replan of their own in the SAME or later round appears.
  // -------------------------------------------------------------------------
  const dependents = new Map<string, Set<string>>();
  const addDependent = (of: string, dependent: string) => {
    if (of === dependent) return;
    let set = dependents.get(of);
    if (!set) dependents.set(of, (set = new Set()));
    set.add(dependent);
  };
  for (const node of nodes.values()) {
    if (node.parentId !== null && !node.probeRow) addDependent(node.parentId, node.logicalId);
    const gates = lastOf(node.gatesRows);
    for (const dep of gates?.depsLogical ?? []) addDependent(dep, node.logicalId);
  }
  const cascadeResolved = (node: InternalNode, round: number): boolean =>
    node.reaffirms.some((row) => row.round >= round) ||
    node.invalidations.some((row) => row.round >= round);
  /** The plan row of a node's CURRENT version (undefined while awaiting replan). */
  const currentPlanOf = (node: InternalNode): DcPlanRow | undefined =>
    lastOf(node.planRows.slice(node.invalidations.length));
  /** A replanned parent's current plan re-declaring a child reaffirms it. */
  const redeclaredByReplannedParent = (parent: InternalNode, childId: string): boolean =>
    parent.invalidations.length > 0 &&
    (currentPlanOf(parent)?.children ?? []).some((child) => child.logicalId === childId);
  for (const source of nodes.values()) {
    for (const invalidation of source.invalidations) {
      const seen = new Set<string>([source.logicalId]);
      const queue: Array<{ id: string; via: string }> = [...(dependents.get(source.logicalId) ?? [])].map(
        (id) => ({ id, via: source.logicalId }),
      );
      while (queue.length) {
        const { id, via } = queue.shift()!;
        if (seen.has(id)) continue;
        seen.add(id);
        const target = nodes.get(id);
        if (!target) continue;
        if (target.parentId === via && nodes.has(via) && redeclaredByReplannedParent(nodes.get(via)!, id)) {
          // Reached as a child of an invalidated-and-replanned ancestor whose
          // current plan kept this node: the new plan row IS the reaffirm,
          // for it and its subtree.
          continue;
        }
        for (const next of dependents.get(id) ?? []) queue.push({ id: next, via: id });
        if (target.probeRow || target.isGoal) continue;
        if (cascadeResolved(target, invalidation.round)) continue;
        target.cascadeRound = Math.max(target.cascadeRound ?? 0, invalidation.round);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Materialize node states
  // -------------------------------------------------------------------------
  const states: Record<string, DelegationNodeState> = {};
  const structuralIds = new Set<string>();
  const kindOf = (node: InternalNode): DelegationNodeKind => {
    if (node.probeRow) return node.probeRow.kind;
    if (node.isGoal) return "goal";
    const latestPlan = lastOf(node.planRows);
    if (latestPlan && latestPlan.children.length > 0) return "chunk";
    if (node.declared) return node.declared.kind;
    if (latestPlan) return "chunk";
    return "leaf";
  };
  const tierOf = (node: InternalNode, kind: DelegationNodeKind): Tier => {
    const latestPlan = lastOf(node.planRows);
    if (latestPlan) return latestPlan.tier;
    if (node.declared) return node.declared.tier;
    if (kind === "poc" || kind === "research") return "haiku";
    if (kind === "goal" || node.parentId === null) return "fable";
    return "sonnet";
  };

  for (const node of nodes.values()) {
    const versionCount = node.invalidations.length + 1;
    const versions: DelegationVersionSnapshot[] = [];
    for (let version = 1; version <= versionCount; version += 1) {
      const isCurrent = version === versionCount;
      const plan = isCurrent ? lastOf(node.planRows.slice(version - 1)) : node.planRows[version - 1];
      const gates = isCurrent ? lastOf(node.gatesRows.slice(version - 1)) : node.gatesRows[version - 1];
      const invalidatedBy = isCurrent ? undefined : node.invalidations[version - 1];
      versions.push({
        version,
        ...(plan ? { plan } : {}),
        ...(gates ? { gates } : {}),
        ...(isCurrent && node.execRows.length ? { exec: [...node.execRows] } : {}),
        ...(isCurrent && node.reviewRows.length ? { review: [...node.reviewRows] } : {}),
        ...(invalidatedBy ? { invalidatedBy } : {}),
      });
    }
    const current = versions[versions.length - 1]!;
    const stickyGates = lastOf(node.gatesRows);
    const kind = kindOf(node);
    const tier = tierOf(node, kind);

    // The node is invalidated (awaiting a replan) when invalidations have
    // outrun its plan supply: its own plan rows for planning nodes, parent
    // re-declarations for leaves that never plan.
    const effectivePlans = node.planRows.length > 0 ? node.planRows.length : node.declarationCount;
    const awaitingReplan = node.invalidations.length > 0 && effectivePlans <= node.invalidations.length;

    const lastReview = lastOf(node.reviewRows);
    const lastExec = lastOf(node.execRows);
    const lastDevPreview = lastOf(node.devPreviews);
    const hasReviewGate = (stickyGates?.gates ?? []).some((gate) => gate.method === "review");
    const hasPreviewGate = (stickyGates?.gates ?? []).some((gate) => gate.method === "preview");

    const status = ((): DelegationNodeStatus | null => {
      if (node.approvalPending) return "awaiting-human";
      if (awaitingReplan) return "invalidated";
      if (node.cascadeRound !== undefined) return "derisking";
      if (node.probeRow) return "done";
      if (node.isGoal) return node.goalRow ? "done" : "running";
      // Post-execution backpressure evidence: review verdicts AND developer
      // previews both gate "done" — a builtOk:false dev preview fails the
      // node like a failed review, until a later attempt/successful row.
      if (lastReview || lastDevPreview) {
        const failures: number[] = [];
        if (lastReview && lastReview.verdict !== "pass") failures.push(lastReview.attempt);
        if (lastDevPreview && !lastDevPreview.row.builtOk) failures.push(lastDevPreview.iteration + 1);
        if (failures.length > 0) {
          const failedAt = Math.max(...failures);
          return lastExec && lastExec.attempt > failedAt ? "running" : "failed";
        }
        const missingGateEvidence = (hasReviewGate && !lastReview) || (hasPreviewGate && !lastDevPreview);
        return missingGateEvidence ? "running" : "done";
      }
      if (node.execRows.length > 0) return hasReviewGate || hasPreviewGate ? "running" : "done";
      return null; // no own lifecycle evidence — resolved below via child rollup
    })();
    if (status === null) structuralIds.add(node.logicalId);

    // User edits that were not yet folded into a replanned version stay
    // visible as the node's live output.
    const latestEdit = lastOf(node.edits);
    const editConsumed =
      latestEdit !== undefined &&
      node.invalidations.some(
        (inv) => inv.trigger.type === "user-edit" && inv.trigger.ref === latestEdit.editId,
      ) &&
      (node.planRows.length === 0 || current.plan !== undefined);
    const output =
      lastExec ??
      (latestEdit && !editConsumed ? latestEdit.editedOutput : undefined) ??
      current.plan ??
      node.probeRow ??
      (node.goalRow ? node.goalRow.refinedPrompt : undefined);

    states[node.logicalId] = {
      logicalId: node.logicalId,
      parentId: node.parentId,
      tier,
      kind,
      title:
        lastOf(node.planRows)?.title ??
        node.declared?.title ??
        (node.probeRow ? node.probeRow.question : node.logicalId),
      brief:
        lastOf(node.planRows)?.brief ??
        node.declared?.brief ??
        (node.probeRow ? node.probeRow.question : node.goalRow?.refinedPrompt ?? ""),
      status: status ?? "planned",
      version: versionCount,
      versions,
      deps: [...(stickyGates?.depsLogical ?? [])],
      gates: [...(stickyGates?.gates ?? [])] as Gate[],
      ...(node.previewRow ? { preview: node.previewRow.expectedOutput } : {}),
      ...(lastDevPreview ? { devPreview: lastDevPreview.row } : {}),
      ...(output !== undefined ? { output } : {}),
      attention: { self: node.approvalPending, descendants: 0 },
    };
  }

  // Structural statuses (nodes with no own lifecycle evidence yet): roll up
  // from children — all children done means done; any execution activity in
  // the subtree means running; otherwise ready/previewing/planned.
  const childrenOf = new Map<string, string[]>();
  for (const state of Object.values(states)) {
    if (state.parentId !== null && states[state.parentId]) {
      const list = childrenOf.get(state.parentId) ?? [];
      list.push(state.logicalId);
      childrenOf.set(state.parentId, list);
    }
  }
  const structuralOrder = Object.keys(states).sort(
    (a, b) => depthOf(states, b) - depthOf(states, a) || a.localeCompare(b),
  );
  for (const id of structuralOrder) {
    if (!structuralIds.has(id)) continue;
    const state = states[id]!;
    const internal = nodes.get(id)!;
    const childIds = (childrenOf.get(id) ?? []).filter((childId) => {
      const child = states[childId]!;
      return child.kind !== "poc" && child.kind !== "research" && child.kind !== "goal";
    });
    const childStates = childIds.map((childId) => states[childId]!.status);
    if (childStates.length > 0 && childStates.every((childStatus) => childStatus === "done")) {
      state.status = "done";
    } else if (childStates.some((childStatus) => childStatus === "running" || childStatus === "done" || childStatus === "failed")) {
      state.status = "running";
    } else if (internal.gatesRows.length > 0) {
      state.status = "ready";
    } else if (internal.previewRow) {
      state.status = "previewing";
    } else {
      state.status = "planned";
    }
  }

  // Attention rollup: descendants counts self-pending nodes strictly below.
  for (const state of Object.values(states)) {
    if (!state.attention.self) continue;
    let parentId = state.parentId;
    const seen = new Set<string>([state.logicalId]);
    while (parentId !== null && states[parentId] && !seen.has(parentId)) {
      seen.add(parentId);
      states[parentId]!.attention.descendants += 1;
      parentId = states[parentId]!.parentId;
    }
  }

  // -------------------------------------------------------------------------
  // Root & edges
  // -------------------------------------------------------------------------
  const rootCandidates = Object.values(states)
    .filter((state) => state.parentId === null && state.kind !== "goal" && state.kind !== "poc" && state.kind !== "research")
    .sort((a, b) => {
      const planned = (nodes.get(b.logicalId)!.planRows.length ? 1 : 0) - (nodes.get(a.logicalId)!.planRows.length ? 1 : 0);
      if (planned !== 0) return planned;
      return a.logicalId.localeCompare(b.logicalId);
    });
  const rootId = rootCandidates[0]?.logicalId ?? null;

  const edgeSet = new Map<string, DelegationEdge>();
  const addEdge = (edge: DelegationEdge) => {
    edgeSet.set(`${edge.kind} ${edge.from} ${edge.to}`, edge);
  };
  for (const state of Object.values(states)) {
    if (state.parentId !== null && states[state.parentId]) {
      // v2 higher-order orchestration: when dcPlan.orchestration === "workflow"
      // lands, a workflow-orchestrated child keeps this same child edge but the
      // UI renders its subtree as a nested authored subgraph (collapsed
      // <Subflow> graph) instead of task rows. The optional field is accepted
      // and ignored today.
      addEdge({
        from: state.parentId,
        to: state.logicalId,
        kind: state.kind === "poc" || state.kind === "research" ? "probe" : "child",
      });
    }
    for (const dep of state.deps) {
      if (states[dep]) addEdge({ from: state.logicalId, to: dep, kind: "dep" });
    }
    // Backpressure (gate) edges: review gates that name another node via an
    // optional logical reference. The frozen Gate shapes carry none, so this
    // only materializes for forward-compatible gate rows that do.
    for (const gate of state.gates) {
      const ref = (gate as { logicalId?: unknown }).logicalId;
      if (typeof ref === "string" && states[ref]) addEdge({ from: state.logicalId, to: ref, kind: "gate" });
    }
  }
  const edges = [...edgeSet.values()].sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
  );

  // -------------------------------------------------------------------------
  // Estimates (latest-wins) & actual rollups
  // -------------------------------------------------------------------------
  const predictedMemo = new Map<string, Estimate | undefined>();
  const predicted = (id: string, visiting: Set<string>): Estimate | undefined => {
    if (predictedMemo.has(id)) return predictedMemo.get(id);
    const node = nodes.get(id);
    if (!node || visiting.has(id)) return node?.declared?.estimate;
    visiting.add(id);
    const latestPlan = lastOf(node.planRows);
    let result: Estimate | undefined;
    if (latestPlan) {
      // Own overhead = own latest subtree estimate minus what it allotted to
      // children; each child's own re-forecast supersedes the allotment.
      const allotted = latestPlan.children.reduce((sum, child) => addEstimates(sum, child.estimate), ZERO_ESTIMATE);
      let total = subtractClamped(latestPlan.subtreeEstimate, allotted);
      for (const child of latestPlan.children) {
        total = addEstimates(total, predicted(child.logicalId, visiting) ?? child.estimate);
      }
      result = total;
    } else {
      result = node.declared?.estimate;
    }
    visiting.delete(id);
    predictedMemo.set(id, result);
    return result;
  };

  const ownActual = (node: InternalNode): Partial<Estimate> =>
    node.execRows.reduce<Partial<Estimate>>((sum, row) => (row.actual ? addPartial(sum, row.actual) : sum), {});
  const actualMemo = new Map<string, Partial<Estimate>>();
  const rollupActual = (id: string, visiting: Set<string>): Partial<Estimate> => {
    const memo = actualMemo.get(id);
    if (memo) return memo;
    if (visiting.has(id)) return {};
    visiting.add(id);
    const node = nodes.get(id);
    let total = node ? ownActual(node) : {};
    for (const childId of childrenOf.get(id) ?? []) {
      total = addPartial(total, rollupActual(childId, visiting));
    }
    visiting.delete(id);
    actualMemo.set(id, total);
    return total;
  };

  for (const state of Object.values(states)) {
    const estimate = predicted(state.logicalId, new Set());
    if (estimate) state.estimate = estimate;
    const actual = rollupActual(state.logicalId, new Set());
    if (hasAnyField(actual)) state.actual = actual;
  }

  let budgetActual: Partial<Estimate> = {};
  for (const node of nodes.values()) budgetActual = addPartial(budgetActual, ownActual(node));
  const budgetPredicted = rootId ? predicted(rootId, new Set()) ?? null : null;

  // -------------------------------------------------------------------------
  // Graph-level fields
  // -------------------------------------------------------------------------
  const pendingQuestions = [...questionsByKey.values()]
    .filter((question) => !question.resolved)
    .sort((a, b) => a.seq - b.seq || a.logicalId.localeCompare(b.logicalId));

  const has = {
    plan: [...nodes.values()].some((node) => node.planRows.length > 0),
    preview: previewsSkipped || [...nodes.values()].some((node) => node.previewRow !== undefined),
    gates: [...nodes.values()].some((node) => node.gatesRows.length > 0),
    derisk: [...nodes.values()].some(
      (node) => node.probeRow !== undefined || node.invalidations.length > 0 || node.reaffirms.length > 0 || node.edits.length > 0,
    ),
    execution: [...nodes.values()].some(
      (node) => node.execRows.length > 0 || node.reviewRows.length > 0 || node.devPreviews.length > 0,
    ),
    scoring: Object.keys(scores).length > 0,
  };
  const phase: DelegationPhase = pollSubmitted
    ? "done"
    : has.scoring
      ? "scoring"
      : has.execution
        ? "execution"
        : has.derisk
          ? "derisk"
          : has.gates
            ? "gates"
            : has.preview
              ? "preview"
              : has.plan
                ? "planning"
                : "goal";

  return {
    nodes: states,
    rootId,
    edges,
    phase,
    pendingQuestions,
    ...(refinedPrompt !== undefined ? { refinedPrompt } : {}),
    budget: { predicted: budgetPredicted, actual: budgetActual },
    ...(Object.keys(scores).length ? { scores } : {}),
  };
}

function depthOf(states: Record<string, DelegationNodeState>, id: string): number {
  let depth = 0;
  let current = states[id];
  const seen = new Set<string>();
  while (current && current.parentId !== null && !seen.has(current.logicalId)) {
    seen.add(current.logicalId);
    current = states[current.parentId];
    depth += 1;
  }
  return depth;
}
