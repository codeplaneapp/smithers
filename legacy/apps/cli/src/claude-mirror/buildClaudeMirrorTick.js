import { deriveClaudeWorkflowPhasesFromFrame } from "@smthrs/graph";
import { SmithersError } from "@smthrs/errors";
import { aggregateNodeDetailEffect } from "../node-detail.js";
import { runPromise } from "../smithersRuntime.js";
import { claudeMirrorContract } from "./claudeMirrorContract.js";
import { claudeMirrorRelevantEventTypes } from "./claudeMirrorRelevantEventTypes.js";
import { extractClaudeMirrorOutputText } from "./extractClaudeMirrorOutputText.js";
import { isTerminalClaudeMirrorNodeState } from "./isTerminalClaudeMirrorNodeState.js";
import { truncateClaudeMirrorText } from "./truncateClaudeMirrorText.js";

const EVENT_PAGE_SIZE = 500;
const MAX_EVENT_PAGES = 20;
const MAX_OUTPUT_ENTRIES = 100;

/**
 * Compute one complete /workflows mirror frame for a run, straight from the
 * durable store: run status, the latest committed frame's phase plan, every
 * known node with its phase/kind/state, which nodes changed after `afterSeq`,
 * the (truncated) outputs of nodes that became terminal, and pending
 * approvals/human requests. This is the single source of truth the plugin's
 * mirror script consumes; the workflow agents just run the command and relay
 * its JSON.
 *
 * @param {any} adapter
 * @param {string} runId
 * @param {{ afterSeq?: number; maxOutputChars?: number; collapsePhases?: boolean }} [options]
 */
export async function buildClaudeMirrorTick(adapter, runId, options = {}) {
  const afterSeq = Math.max(0, Math.floor(options.afterSeq ?? 0));
  const maxOutputChars = Math.max(0, Math.floor(options.maxOutputChars ?? 2000));

  const run = await adapter.getRun(runId);
  if (!run) {
    throw new SmithersError("RUN_NOT_FOUND", `Run not found: ${runId}`, { runId });
  }

  const nodeRows = await adapter.listNodes(runId);
  /** @type {Record<string, string>} */
  const labels = {};
  for (const row of nodeRows) {
    if (typeof row.label === "string" && row.label.length > 0) {
      labels[row.nodeId] = row.label;
    }
  }

  const frame = await adapter.getLastFrame(runId);
  const plan = deriveClaudeWorkflowPhasesFromFrame(
    {
      xmlJson: frame?.xmlJson ?? null,
      taskIndexJson: frame?.taskIndexJson ?? null,
    },
    { labels, collapsePhases: options.collapsePhases === true },
  );

  const planByNodeId = new Map(plan.nodes.map((node) => [node.nodeId, node]));
  const planByLogicalId = new Map();
  for (const node of plan.nodes) {
    const logical = logicalNodeId(node.nodeId);
    if (!planByLogicalId.has(logical)) {
      planByLogicalId.set(logical, node);
    }
  }
  const fallbackPhase = plan.phases[0]?.title ?? "Workflow";

  /** @param {string} nodeId */
  const planFor = (nodeId) => planByNodeId.get(nodeId) ?? planByLogicalId.get(logicalNodeId(nodeId));

  // Latest iteration wins per nodeId: loop iterations share the row identity
  // the mirror renders.
  /** @type {Map<string, any>} */
  const latestByNodeId = new Map();
  for (const row of nodeRows) {
    const existing = latestByNodeId.get(row.nodeId);
    if (!existing || (row.iteration ?? 0) > (existing.iteration ?? 0)) {
      latestByNodeId.set(row.nodeId, row);
    }
  }

  const { changedNodeIds, newestSeq } = await collectChangedNodeIds(adapter, runId, afterSeq);

  const nodes = [...latestByNodeId.values()].map((row) => {
    const planned = planFor(row.nodeId);
    return {
      nodeId: row.nodeId,
      label: row.label ?? planned?.label ?? row.nodeId,
      phase: planned?.phase ?? fallbackPhase,
      kind: planned?.kind ?? "unknown",
      state: row.state,
      iteration: row.iteration ?? 0,
      attempt: row.lastAttempt ?? 0,
    };
  });
  // Frame-materialized tasks that have no node row yet still render as
  // pending rows, so the mirror shows upcoming work like smithers' own UI.
  for (const planned of plan.nodes) {
    if (!latestByNodeId.has(planned.nodeId)) {
      nodes.push({
        nodeId: planned.nodeId,
        label: planned.label,
        phase: planned.phase,
        kind: planned.kind,
        state: "pending",
        iteration: 0,
        attempt: 0,
      });
    }
  }

  const changed = [...changedNodeIds].filter((nodeId) => latestByNodeId.has(nodeId) || planFor(nodeId));

  /** @type {Record<string, string>} */
  const outputs = {};
  let outputsTruncated = false;
  const terminalChanged = changed.filter((nodeId) =>
    isTerminalClaudeMirrorNodeState(latestByNodeId.get(nodeId)?.state),
  );
  for (const nodeId of terminalChanged) {
    if (Object.keys(outputs).length >= MAX_OUTPUT_ENTRIES) {
      outputsTruncated = true;
      break;
    }
    const detail = await runPromise(aggregateNodeDetailEffect(adapter, { runId, nodeId })).catch(() => undefined);
    if (detail) {
      outputs[nodeId] = truncateClaudeMirrorText(extractClaudeMirrorOutputText(detail), maxOutputChars);
    }
  }

  const approvalRows = await adapter.listPendingApprovals(runId);
  const approvals = approvalRows.map((row) => ({
    nodeId: row.nodeId,
    iteration: row.iteration ?? 0,
    title: approvalTitle(row.requestJson),
    requestedAtMs: row.requestedAtMs ?? null,
  }));

  const humanRows = await adapter.listPendingHumanRequests();
  const humanRequests = humanRows
    .filter((row) => row.runId === runId)
    .map((row) => ({
      requestId: row.requestId,
      nodeId: row.nodeId,
      kind: row.kind,
      prompt: truncateClaudeMirrorText(String(row.prompt ?? ""), maxOutputChars),
    }));

  let continuedAs = null;
  if (run.status === "continued") {
    const child = await Promise.resolve(adapter.getLatestChildRun(runId)).catch(() => undefined);
    continuedAs = child?.runId ?? null;
  }

  return {
    contract: claudeMirrorContract,
    runId,
    status: run.status,
    seq: newestSeq,
    frameNo: frame?.frameNo ?? 0,
    timedOut: false,
    phases: plan.phases,
    nodes,
    changed,
    outputs,
    ...(outputsTruncated ? { outputsTruncated } : {}),
    approvals,
    humanRequests,
    continuedAs,
  };
}

/**
 * Scan the event log after `afterSeq` for mirror-relevant node changes.
 * Returns the newest seq observed (of ANY type) so callers never rescan
 * irrelevant chatter.
 *
 * @param {any} adapter
 * @param {string} runId
 * @param {number} afterSeq
 */
async function collectChangedNodeIds(adapter, runId, afterSeq) {
  const changedNodeIds = new Set();
  let cursor = afterSeq;
  for (let page = 0; page < MAX_EVENT_PAGES; page++) {
    const rows = await adapter.listEventHistory(runId, { afterSeq: cursor, limit: EVENT_PAGE_SIZE });
    if (!Array.isArray(rows) || rows.length === 0) {
      break;
    }
    for (const row of rows) {
      const seq = Number(row.seq ?? 0);
      if (seq > cursor) {
        cursor = seq;
      }
      const type = String(row.type ?? "");
      if (!claudeMirrorRelevantEventTypes.has(type)) {
        continue;
      }
      const payload = parsePayload(row.payloadJson);
      const nodeId = payload && typeof payload.nodeId === "string" ? payload.nodeId : undefined;
      if (nodeId) {
        changedNodeIds.add(nodeId);
      }
    }
    if (rows.length < EVENT_PAGE_SIZE) {
      break;
    }
  }
  return { changedNodeIds, newestSeq: cursor };
}

/** @param {unknown} payloadJson */
function parsePayload(payloadJson) {
  if (typeof payloadJson !== "string" || payloadJson.length === 0) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(payloadJson);
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** @param {unknown} requestJson */
function approvalTitle(requestJson) {
  if (typeof requestJson !== "string" || requestJson.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(requestJson);
    const title = parsed?.title ?? parsed?.prompt ?? parsed?.description;
    return typeof title === "string" && title.length > 0 ? title : null;
  } catch {
    return null;
  }
}

/** @param {string} nodeId */
function logicalNodeId(nodeId) {
  return String(nodeId).split("@@")[0];
}
