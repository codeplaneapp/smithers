import { digestProofRow } from "@smithers-orchestrator/driver/provenance";
import { buildStateKey } from "@smithers-orchestrator/scheduler/buildStateKey";

/**
 * @param {unknown} value
 * @returns {value is import("@smithers-orchestrator/graph/ProofBinding").ProofBinding}
 */
function isProofBinding(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.table === "string" &&
    typeof value.nodeId === "string" &&
    typeof value.iteration === "number" &&
    Number.isFinite(value.iteration) &&
    typeof value.digest === "string",
  );
}

/**
 * The row identity deliberately excludes the digest. A digest change for the
 * same (table,nodeId,iteration) is a DB-level mutation and must retain the
 * original proof across re-render/resume; a new iteration is a newly-produced
 * authority row and may establish a new proof.
 * @param {import("@smithers-orchestrator/graph/ProofBinding").ProofBinding} binding
 */
function bindingIdentity(binding) {
  return JSON.stringify([binding.table, binding.nodeId, binding.iteration]);
}

/**
 * Restore pinned task bindings from the latest durable frame. Older frames
 * simply omit the fields and produce an empty map.
 * @param {{ taskIndexJson?: string | null } | null | undefined} frame
 * @returns {Map<string, import("@smithers-orchestrator/graph/ProofBinding").ProofBinding[]>}
 */
export function proofBindingsFromFrame(frame) {
  const restored = new Map();
  if (!frame?.taskIndexJson) return restored;
  let entries;
  try {
    entries = JSON.parse(frame.taskIndexJson);
  } catch {
    return restored;
  }
  if (!Array.isArray(entries)) return restored;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const nodeId = typeof entry.nodeId === "string" ? entry.nodeId : undefined;
    const iteration = typeof entry.iteration === "number" && Number.isFinite(entry.iteration) ? entry.iteration : 0;
    const bindings = Array.isArray(entry.proofBindings) ? entry.proofBindings.filter(isProofBinding) : undefined;
    if (nodeId && bindings && bindings.length === entry.proofBindings.length) {
      restored.set(
        buildStateKey(nodeId, iteration),
        bindings.map((binding) => ({ ...binding })),
      );
    }
  }
  return restored;
}

/**
 * Pin same-row proof digests across re-renders and resumed engine processes.
 * A candidate that points at a different row identity (normally a later
 * producer iteration) replaces the old proof; merely observing mutated
 * content at the same identity never silently re-blesses it.
 *
 * @param {readonly import("@smithers-orchestrator/graph").TaskDescriptor[]} tasks
 * @param {Map<string, import("@smithers-orchestrator/graph/ProofBinding").ProofBinding[]>} pinned
 */
export function pinTaskProofBindings(tasks, pinned) {
  for (const task of tasks) {
    const key = buildStateKey(task.nodeId, task.iteration);
    if (!task.proofBindingRequired) {
      pinned.delete(key);
      task.proofBindings = undefined;
      task.proofBindingStatus = undefined;
      continue;
    }
    const candidate = task.proofBindings;
    const existing = pinned.get(key);
    if (!candidate) {
      if (existing) {
        task.proofBindings = existing.map((binding) => ({ ...binding }));
      }
      continue;
    }
    const existingByIdentity = new Map((existing ?? []).map((binding) => [bindingIdentity(binding), binding]));
    // Repin independently. A later producer row may establish a new proof,
    // while a sibling binding that still names the same durable row keeps
    // its original digest and therefore still detects DB-level mutation.
    const next = candidate.map((binding) => ({
      ...(existingByIdentity.get(bindingIdentity(binding)) ?? binding),
    }));
    pinned.set(key, next);
    task.proofBindings = next.map((binding) => ({ ...binding }));
  }
}

/**
 * Recompute every pinned row digest from the fresh schedule-time output
 * snapshot and annotate task descriptors for the scheduler. Missing declared
 * proofs wait for their producer; a previously-proved row that disappeared or
 * changed is stale.
 *
 * @param {readonly import("@smithers-orchestrator/graph").TaskDescriptor[]} tasks
 * @param {Record<string, readonly unknown[]>} outputs
 */
export function verifyTaskProofBindings(tasks, outputs) {
  for (const task of tasks) {
    if (!task.proofBindingRequired) {
      task.proofBindingStatus = undefined;
      continue;
    }
    // An empty binding list proves nothing; treating it as verifiable
    // would dispatch a proof-required task with zero authority checks.
    if (!task.proofBindings || task.proofBindings.length === 0) {
      task.proofBindingStatus = "missing";
      continue;
    }
    let stale = false;
    for (const binding of task.proofBindings) {
      const rows = outputs[binding.table] ?? [];
      const row = rows.find((candidate) =>
        Boolean(
          candidate &&
          typeof candidate === "object" &&
          !Array.isArray(candidate) &&
          candidate.nodeId === binding.nodeId &&
          Number(candidate.iteration ?? 0) === binding.iteration,
        ),
      );
      if (!row || digestProofRow(row) !== binding.digest) {
        stale = true;
        break;
      }
    }
    task.proofBindingStatus = stale ? "stale" : "current";
  }
}
