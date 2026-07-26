// @smithers-type-exports-begin
/** @typedef {import("./delegationSchemas.ts").DcExecRow} DcExecRow */
/** @typedef {import("./delegationSchemas.ts").DcGatesRow} DcGatesRow */
/** @typedef {import("./delegationSchemas.ts").DcPlanRow} DcPlanRow */
/** @typedef {import("./delegationSchemas.ts").Tier} Tier */
// @smithers-type-exports-end

import { DEFAULT_TIER_ORDER } from "./delegationSchemasRuntime.js";
/** @typedef {import("@smithers-orchestrator/agents/AgentLike").AgentLike} AgentLike */

/**
 * Pure render-time fold helpers for the delegation composites. Every composite
 * re-derives its slice of the delegation tree from raw output rows on each
 * render (the reactive fan-out idiom) — these helpers are that derivation.
 * They are deliberately non-React and exported for direct unit testing.
 */

/**
 * Read every row of an output table from the workflow context. Targets may be
 * zod schemas from `createSmithers(...).outputs` (resolved via the registered
 * key) or plain table-name strings.
 * @param {import("@smithers-orchestrator/driver").SmithersCtx<any> | null} ctx
 * @param {unknown} target
 * @returns {Record<string, any>[]}
 */
export function readRows(ctx, target) {
  if (!ctx || target == null) return [];
  try {
    const name = ctx.resolveTableName(target);
    const rows = ctx.outputs(name);
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

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
export function physicalId(idPrefix, logicalId, phase) {
  return `${idPrefix}:${logicalId.replaceAll("/", ":")}:${phase}`;
}

/**
 * Rows written by a specific physical node id (ignoring loop-scope suffixes).
 * @param {Record<string, any>[]} rows
 * @param {string} nodeId
 * @returns {Record<string, any>[]}
 */
export function rowsForNode(rows, nodeId) {
  return rows.filter((row) => {
    const id = typeof row.nodeId === "string" ? row.nodeId : "";
    const at = id.indexOf("@@");
    return (at === -1 ? id : id.slice(0, at)) === nodeId;
  });
}

/**
 * The most recent row of a set: highest iteration wins, insertion order breaks ties.
 * @param {Record<string, any>[]} rows
 * @returns {Record<string, any> | undefined}
 */
export function latestRow(rows) {
  let best;
  let bestIteration = -Infinity;
  for (const row of rows) {
    const iter = Number.isFinite(Number(row.iteration)) ? Number(row.iteration) : 0;
    if (!best || iter >= bestIteration) {
      best = row;
      bestIteration = iter;
    }
  }
  return best;
}

/**
 * Fold dcPlan rows into the current plan per logical id (last row per node
 * wins — replans append superseding rows) plus the version count.
 * @param {Record<string, any>[]} planRows
 * @returns {Map<string, { plan: DcPlanRow; versions: number }>}
 */
export function foldPlans(planRows) {
  /** @type {Map<string, { plan: DcPlanRow; versions: number }>} */
  const plans = new Map();
  for (const row of planRows) {
    if (typeof row.logicalId !== "string") continue;
    const prev = plans.get(row.logicalId);
    plans.set(row.logicalId, {
      plan: /** @type {DcPlanRow} */ (/** @type {unknown} */ (row)),
      versions: (prev?.versions ?? 0) + 1,
    });
  }
  return plans;
}

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
export function nodeIndex(plans) {
  /** @type {Map<string, DelegationNodeInfo>} */
  const nodes = new Map();
  for (const [logicalId, { plan }] of plans) {
    for (const child of plan.children ?? []) {
      nodes.set(child.logicalId, {
        logicalId: child.logicalId,
        parentId: logicalId,
        tier: child.tier,
        kind: child.kind,
        title: child.title,
        brief: child.brief,
        estimate: child.estimate,
      });
    }
  }
  for (const [logicalId, { plan }] of plans) {
    const declared = nodes.get(logicalId);
    nodes.set(logicalId, {
      logicalId,
      parentId: declared?.parentId ?? null,
      tier: plan.tier,
      kind: "chunk",
      title: plan.title,
      brief: plan.brief,
      estimate: plan.subtreeEstimate ?? declared?.estimate,
    });
  }
  return nodes;
}

/**
 * Children declared as chunks that have no plan row of their own yet — the
 * next planning fan-out frontier.
 * @param {Map<string, { plan: DcPlanRow; versions: number }>} plans
 * @returns {DelegationNodeInfo[]}
 */
export function unplannedChunks(plans) {
  const nodes = nodeIndex(plans);
  /** @type {DelegationNodeInfo[]} */
  const result = [];
  for (const node of nodes.values()) {
    if (node.kind === "chunk" && !plans.has(node.logicalId)) {
      result.push(node);
    }
  }
  return result;
}

/**
 * The current execution frontier: every child declared as a leaf (and not
 * superseded by its own plan row).
 * @param {Map<string, { plan: DcPlanRow; versions: number }>} plans
 * @returns {DelegationNodeInfo[]}
 */
export function frontierLeaves(plans) {
  const nodes = nodeIndex(plans);
  /** @type {DelegationNodeInfo[]} */
  const result = [];
  for (const node of nodes.values()) {
    if (node.kind === "leaf" && !plans.has(node.logicalId)) {
      result.push(node);
    }
  }
  return result;
}

/**
 * Planning is complete when a root plan exists and every declared chunk has
 * produced its own plan row (the frontier is all leaves).
 * @param {Map<string, { plan: DcPlanRow; versions: number }>} plans
 * @returns {boolean}
 */
export function planningComplete(plans) {
  return plans.size > 0 && unplannedChunks(plans).length === 0;
}

/**
 * Latest dcGates row per logical id.
 * @param {Record<string, any>[]} gatesRows
 * @returns {Map<string, DcGatesRow>}
 */
export function foldGates(gatesRows) {
  /** @type {Map<string, DcGatesRow>} */
  const map = new Map();
  for (const row of gatesRows) {
    if (typeof row.logicalId === "string") {
      map.set(row.logicalId, /** @type {DcGatesRow} */ (/** @type {unknown} */ (row)));
    }
  }
  return map;
}

/**
 * Transitive dependents of a node: everything reachable by walking child
 * edges down from it plus reverse `depsLogical` edges (invalidation cascades
 * along BOTH — see the simulation's calibration delta #3). Excludes the node.
 * @param {string} logicalId
 * @param {Map<string, { plan: DcPlanRow; versions: number }>} plans
 * @param {Map<string, DcGatesRow>} gates
 * @returns {string[]}
 */
export function dependentsOf(logicalId, plans, gates) {
  const nodes = nodeIndex(plans);
  /** @type {Map<string, string[]>} */
  const forward = new Map();
  for (const node of nodes.values()) {
    if (node.parentId) {
      const list = forward.get(node.parentId) ?? [];
      list.push(node.logicalId);
      forward.set(node.parentId, list);
    }
  }
  for (const [id, row] of gates) {
    for (const dep of row.depsLogical ?? []) {
      const list = forward.get(dep) ?? [];
      list.push(id);
      forward.set(dep, list);
    }
  }
  /** @type {Set<string>} */
  const seen = new Set();
  const queue = [logicalId];
  while (queue.length > 0) {
    const current = /** @type {string} */ (queue.shift());
    for (const next of forward.get(current) ?? []) {
      if (!seen.has(next) && next !== logicalId) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return [...seen];
}

/**
 * Map a logical id to the nearest ancestor-or-self that owns a plan row (the
 * delegating node responsible for replanning it). Leaves map to their parent.
 * @param {string} logicalId
 * @param {Map<string, { plan: DcPlanRow; versions: number }>} plans
 * @returns {string | null}
 */
export function planOwnerOf(logicalId, plans) {
  const nodes = nodeIndex(plans);
  /** @type {string | null} */
  let current = logicalId;
  while (current) {
    if (plans.has(current)) return current;
    current = nodes.get(current)?.parentId ?? null;
  }
  return null;
}

/**
 * All frontier leaves at or under a logical id (a chunk-level dependency
 * expands to every leaf beneath it).
 * @param {string} logicalId
 * @param {Map<string, { plan: DcPlanRow; versions: number }>} plans
 * @returns {DelegationNodeInfo[]}
 */
export function leavesUnder(logicalId, plans) {
  return frontierLeaves(plans).filter(
    (leaf) => leaf.logicalId === logicalId || leaf.logicalId.startsWith(`${logicalId}/`),
  );
}

/**
 * Deterministic probe id for a plan risk.
 * @param {string} parentLogicalId
 * @param {string} riskId
 * @returns {string}
 */
export function probeIdFor(parentLogicalId, riskId) {
  return `${parentLogicalId}#${riskId}`;
}

/**
 * Risks across the current plans that request a probe.
 * @param {Map<string, { plan: DcPlanRow; versions: number }>} plans
 * @returns {Array<{ parentLogicalId: string; probeId: string; kind: "poc" | "research"; risk: DcPlanRow["risks"][number] }>}
 */
export function probesRequested(plans) {
  /** @type {Array<{ parentLogicalId: string; probeId: string; kind: "poc" | "research"; risk: DcPlanRow["risks"][number] }>} */
  const result = [];
  for (const [logicalId, { plan }] of plans) {
    for (const risk of plan.risks ?? []) {
      if (risk.probe === "poc" || risk.probe === "research") {
        result.push({
          parentLogicalId: logicalId,
          probeId: probeIdFor(logicalId, risk.id),
          kind: risk.probe,
          risk,
        });
      }
    }
  }
  return result;
}

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
export function pendingTriggers(probeRows, editRows, replanRows, chunkFailures = []) {
  const addressed = new Set(replanRows.map((row) => row?.trigger?.ref).filter((ref) => typeof ref === "string"));
  /** @type {DeriskTrigger[]} */
  const triggers = [];
  for (const row of probeRows) {
    if (row.planImpact === "changes" && !addressed.has(row.probeId)) {
      triggers.push({
        type: "probe",
        ref: String(row.probeId),
        flagged: String(row.parentLogicalId),
        detail: row,
      });
    }
  }
  for (const row of editRows) {
    if (typeof row.editId === "string" && !addressed.has(row.editId)) {
      triggers.push({
        type: "user-edit",
        ref: row.editId,
        flagged: String(row.logicalId),
        detail: row,
      });
    }
  }
  for (const failure of chunkFailures) {
    if (!addressed.has(failure.ref)) {
      triggers.push({
        type: "review-fail",
        ref: failure.ref,
        flagged: failure.logicalId,
        detail: failure,
      });
    }
  }
  return triggers;
}

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
export function triggerTargetOf(flagged, plans) {
  const hash = flagged.indexOf("#");
  const base = hash === -1 ? flagged : flagged.slice(0, hash);
  if (base === "goal" && !plans.has("goal")) return "root";
  return base;
}

/**
 * How many replan decisions a node has already made (its per-node round counter).
 * @param {Record<string, any>[]} replanRows
 * @param {string} logicalId
 * @returns {number}
 */
export function replanCountFor(replanRows, logicalId) {
  return replanRows.filter((row) => row.logicalId === logicalId).length;
}

/**
 * Sum best-effort actuals across dcExec rows.
 * @param {Record<string, any>[]} execRows
 * @returns {{ tokens: number; costUsd: number; minutes: number }}
 */
export function actualTotals(execRows) {
  const totals = { tokens: 0, costUsd: 0, minutes: 0 };
  for (const row of execRows) {
    const actual = row?.actual;
    if (actual && typeof actual === "object") {
      if (typeof actual.tokens === "number") totals.tokens += actual.tokens;
      if (typeof actual.costUsd === "number") totals.costUsd += actual.costUsd;
      if (typeof actual.minutes === "number") totals.minutes += actual.minutes;
    }
  }
  return totals;
}

/**
 * Split a dcGates row into ordered gate lists. Approval gates are only kept
 * when an approval policy was provided (contract: approval gates exist ONLY
 * under an approvalPolicy).
 * @param {DcGatesRow | undefined} gatesRow
 * @param {string | undefined} approvalPolicy
 */
export function splitGates(gatesRow, approvalPolicy) {
  /** @type {Extract<import("./delegationSchemas.ts").Gate, { method: "review" }>[]} */
  const reviews = [];
  /** @type {Extract<import("./delegationSchemas.ts").Gate, { method: "check" }>[]} */
  const checks = [];
  /** @type {Extract<import("./delegationSchemas.ts").Gate, { method: "approval" }>[]} */
  const approvals = [];
  /** @type {Extract<import("./delegationSchemas.ts").Gate, { method: "preview" }>[]} */
  const previews = [];
  for (const gate of gatesRow?.gates ?? []) {
    if (gate.method === "review") reviews.push(gate);
    else if (gate.method === "check") checks.push(gate);
    else if (gate.method === "approval" && approvalPolicy) approvals.push(gate);
    else if (gate.method === "preview") previews.push(gate);
  }
  return { reviews, checks, approvals, previews };
}

/**
 * Physical node id for a node's i-th developer-preview gate
 * (`dev-preview`, then `dev-preview-2`, ...).
 * @param {string} idPrefix
 * @param {string} logicalId
 * @param {number} index zero-based gate index
 * @returns {string}
 */
export function devPreviewNodeId(idPrefix, logicalId, index) {
  return physicalId(idPrefix, logicalId, index === 0 ? "dev-preview" : `dev-preview-${index + 1}`);
}

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
export function leafAttemptState(opts) {
  const ownExec = rowsForNode(opts.execRows, opts.execId);
  const latestIteration = ownExec.reduce((max, row) => Math.max(max, Number(row.iteration) || 0), -1);
  const attempts = ownExec.length;
  /** @type {string[]} */
  const failedFeedback = [];
  let allPass = attempts > 0;
  for (const gateNodeId of opts.gateNodeIds) {
    const rows = rowsForNode(opts.reviewRows, gateNodeId).filter(
      (row) => (Number(row.iteration) || 0) === latestIteration,
    );
    const latest = rows[rows.length - 1];
    if (!latest || latest.verdict !== "pass") {
      allPass = false;
    }
    if (latest && latest.verdict === "fail") {
      failedFeedback.push(String(latest.feedback ?? ""));
    }
  }
  // Developer-preview gates: the built artifact (builtOk) is REQUIRED for
  // the node to pass; a failed build fails the attempt like a failed review.
  for (const previewNodeId of opts.previewNodeIds ?? []) {
    const rows = rowsForNode(opts.devPreviewRows ?? [], previewNodeId).filter(
      (row) => (Number(row.iteration) || 0) === latestIteration,
    );
    const latest = rows[rows.length - 1];
    if (!latest || latest.builtOk !== true) {
      allPass = false;
    }
    if (latest && latest.builtOk !== true) {
      failedFeedback.push(`Developer preview failed to build: ${String(latest.summary ?? "")}`);
    }
  }
  return { attempts, latestIteration, allPass, failedFeedback };
}

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
export function leafComplete(opts) {
  const gatesRow = opts.gates.get(opts.leaf.logicalId);
  const { reviews, checks, approvals, previews } = splitGates(gatesRow, opts.approvalPolicy);
  const gateNodeIds = [...reviews, ...checks].map((_, i) =>
    physicalId(opts.idPrefix, opts.leaf.logicalId, `review-${i + 1}`),
  );
  const state = leafAttemptState({
    execRows: opts.execRows,
    reviewRows: opts.reviewRows,
    execId: physicalId(opts.idPrefix, opts.leaf.logicalId, "exec"),
    gateNodeIds,
    devPreviewRows: opts.devPreviewRows ?? [],
    previewNodeIds: previews.map((_, i) => devPreviewNodeId(opts.idPrefix, opts.leaf.logicalId, i)),
  });
  if (!state.allPass) return false;
  return approvals.every((_, i) => {
    const rows = rowsForNode(opts.approvalRows, physicalId(opts.idPrefix, opts.leaf.logicalId, `approval-${i + 1}`));
    return rows.some((row) => row.approved === true);
  });
}

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
export function chunkGateFailures(opts) {
  /** @type {ChunkGateFailure[]} */
  const failures = [];
  for (const node of nodeIndex(opts.plans).values()) {
    if (node.kind === "leaf") continue;
    const { reviews } = splitGates(opts.gates.get(node.logicalId), opts.approvalPolicy);
    for (let i = 0; i < reviews.length; i++) {
      const gateNodeId = physicalId(opts.idPrefix, node.logicalId, `review-${i + 1}`);
      const rows = rowsForNode(opts.reviewRows, gateNodeId);
      const latest = rows[rows.length - 1];
      if (latest && latest.verdict === "fail") {
        failures.push({
          logicalId: node.logicalId,
          gateNodeId,
          ref: `${gateNodeId}#fail-${rows.length}`,
          feedback: String(latest.feedback ?? ""),
        });
      }
    }
  }
  return failures;
}

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
export function executionComplete(opts) {
  if (!planningComplete(opts.plans)) return false;
  const leaves = frontierLeaves(opts.plans);
  if (leaves.length === 0 || !leaves.every((leaf) => leafComplete({ ...opts, leaf }))) return false;
  const failures = chunkGateFailures(opts);
  if (failures.length === 0) return true;
  const maxRounds = opts.maxDeriskRounds ?? 3;
  const rr = opts.replanRows ?? [];
  const addressed = new Set(rr.map((row) => row?.trigger?.ref).filter((ref) => typeof ref === "string"));
  // A chunk failure is terminal once addressed by a replan (matched on
  // trigger.ref) OR once its owning node has exhausted its per-node derisk
  // budget — otherwise an exhausted owner + a pinned latest-fail chunk review
  // would wedge the run forever (executionComplete never turning true).
  return failures.every((failure) => addressed.has(failure.ref) || replanCountFor(rr, failure.logicalId) >= maxRounds);
}

/**
 * Resolve a tier label to an agent from the `agents` prop, walking down the
 * tier order for the nearest configured fallback.
 * @param {Partial<Record<Tier, AgentLike | AgentLike[]>>} agents
 * @param {Tier} tier
 * @param {readonly Tier[]} [tierOrder]
 * @returns {AgentLike | AgentLike[] | undefined}
 */
export function agentForTier(agents, tier, tierOrder = DEFAULT_TIER_ORDER) {
  if (agents[tier]) return agents[tier];
  const start = tierOrder.indexOf(tier);
  for (let i = start + 1; i < tierOrder.length; i++) {
    const candidate = agents[tierOrder[i]];
    if (candidate) return candidate;
  }
  for (let i = start - 1; i >= 0; i--) {
    const candidate = agents[tierOrder[i]];
    if (candidate) return candidate;
  }
  return undefined;
}

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
export function synthesizeDelegationEvents(opts) {
  /** @type {Record<string, any>[]} */
  const events = [];
  // 1. Planning: every declared risk is a flag by its owner; probed risks
  //    spawn probe nodes (`probe` carries the probe id so the scorers can
  //    exclude probes from the planning-node set).
  for (const row of opts.planRows) {
    if (typeof row.logicalId !== "string") continue;
    for (const risk of row.risks ?? []) {
      events.push({ t: "RISK_FLAGGED", node: row.logicalId, risk: String(risk?.id ?? "") });
      if (risk?.probe === "poc" || risk?.probe === "research") {
        events.push({
          t: "PROBE_SPAWNED",
          parent: row.logicalId,
          probe: probeIdFor(row.logicalId, String(risk.id)),
          kind: risk.probe,
        });
      }
    }
  }
  // 2. Probe findings report to the nearest parent only.
  for (const row of opts.probeRows) {
    events.push({
      t: "FINDING_REPORTED",
      probe: String(row.probeId ?? ""),
      toParent: String(row.parentLogicalId ?? ""),
      planImpact: row.planImpact,
    });
  }
  /** @param {Record<string, any>} row */
  const pushReplan = (row) => {
    const node = String(row.logicalId ?? "");
    events.push({ t: "REPLAN_REQUESTED", from: node, reason: String(row.reason ?? ""), trigger: row.trigger });
    events.push({ t: row.decision === "invalidated" ? "NODE_INVALIDATED" : "NODE_REAFFIRMED", node });
  };
  // 3. Plan-phase replan decisions (probe findings + live user edits).
  for (const row of opts.replanRows) {
    if (row?.trigger?.type !== "review-fail") pushReplan(row);
  }
  // 4. Execution: the first attempt per node starts it; retries redelegate.
  /** @type {Set<string>} */
  const executed = new Set();
  for (const row of opts.execRows) {
    const node = String(row.logicalId ?? "");
    if (executed.has(node)) {
      events.push({ t: "REDELEGATED", node });
    } else {
      executed.add(node);
      events.push({ t: "EXEC_STARTED", node });
    }
  }
  // 5. Gate verdicts (reviews/checks write dcReview; a dev preview that
  //    failed to build fails its gate like a failed review).
  for (const row of opts.reviewRows) {
    events.push({ t: row.verdict === "fail" ? "GATE_FAILED" : "GATE_PASSED", node: String(row.logicalId ?? "") });
  }
  for (const row of opts.devPreviewRows ?? []) {
    if (row.builtOk !== true) {
      events.push({ t: "GATE_FAILED", node: String(row.logicalId ?? ""), gate: "preview" });
    }
  }
  // 6. Post-exec replans (chunk review failures — see chunkGateFailures).
  for (const row of opts.replanRows) {
    if (row?.trigger?.type === "review-fail") pushReplan(row);
  }
  // 7. Completion per executed node.
  for (const node of executed) {
    events.push({ t: "NODE_DONE", node });
  }
  return events;
}

/**
 * The tier responsible for declaring a node's gates and replans: the node's
 * own tier for delegating nodes, the parent's tier for leaves.
 * @param {DelegationNodeInfo | undefined} node
 * @param {Map<string, DelegationNodeInfo>} nodes
 * @param {readonly Tier[]} tierOrder
 * @returns {Tier}
 */
export function delegatingTierFor(node, nodes, tierOrder = DEFAULT_TIER_ORDER) {
  if (!node) return /** @type {Tier} */ (tierOrder[0]);
  if (node.kind !== "leaf") return node.tier;
  const parent = node.parentId ? nodes.get(node.parentId) : undefined;
  return parent?.tier ?? /** @type {Tier} */ (tierOrder[0]);
}
