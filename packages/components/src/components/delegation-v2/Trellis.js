// @smithers-type-exports-begin
/** @typedef {import("./TrellisProps.ts").TrellisProps} TrellisProps */
// @smithers-type-exports-end

import React from "react";
import { SmithersContext } from "@smithers-orchestrator/react-reconciler/context";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { Task } from "../Task.js";
import { Sequence } from "../Sequence.js";
import { Parallel } from "../Parallel.js";
import {
  acceptanceCriterionSchema,
  authorEnvelopeSchemaFor,
  delegationV2OutputContractAllowed,
  DELEGATION_V2_PROTOCOL_VERSION,
  DELEGATION_V2_REGISTRY_VERSION,
  goalContractSchema,
  localIdSchema,
  outputContractIdSchema,
  workerEnvelopeSchemaFor,
} from "./delegationV2SchemasRuntime.js";
import {
  DELEGATION_V2_PROMPT_CONTRACT_VERSION,
  renderContinuationAuthorPrompt,
  renderInitialAuthorPrompt,
  renderRepairAuthorPrompt,
  renderWorkerPrompt,
} from "./delegationV2Prompts.js";
import { hashStableValue, invocationOutcomeNodeId, isGatewaySafeNodeId, turnNodeId } from "./delegationV2Ids.js";
import {
  DEFAULT_DELEGATION_V2_LIMITS,
  delegationV2ProgramDigest,
  validateWorkflowProgram,
} from "./delegationV2Validate.js";
import { compileDelegationV2Program, DELEGATION_V2_COMPILER_VERSION } from "./delegationV2Compiler.js";
import { enforceDelegationV2AuthorFuel, partitionDelegationV2AuthorFuel } from "./delegationV2Fuel.js";
import { DELEGATION_V2_RUNTIME_VERSION, settleDelegationV2Envelope } from "./delegationV2Settlement.js";
import {
  buildDelegationV2EvidencePacket,
  collectDelegationV2Outcomes,
  delegationV2RowForNode,
  readDelegationV2Rows,
} from "./delegationV2State.js";
import {
  deriveCriticalReviewIndependentRoles,
  normalizeCriticalExecutionPolicy,
} from "./delegationV2CriticalExecution.js";

const AUTHOR_ROLES = new Set(["sol", "fable"]);
export { DELEGATION_V2_RUNTIME_VERSION } from "./delegationV2Settlement.js";
const DEFAULT_LIMITS = Object.freeze({
  maxTotalAuthorTurns: 32,
  maxAuthorGenerations: 4,
  maxAuthorDepth: 4,
  maxNodesPerProgram: DEFAULT_DELEGATION_V2_LIMITS.maxNodes,
  maxProgramDepth: DEFAULT_DELEGATION_V2_LIMITS.maxDepth,
  maxFanout: DEFAULT_DELEGATION_V2_LIMITS.maxFanout,
  maxPromptBytes: DEFAULT_DELEGATION_V2_LIMITS.maxPromptBytes,
  maxTotalPromptBytes: DEFAULT_DELEGATION_V2_LIMITS.maxTotalPromptBytes,
});

/** @param {unknown} value @param {string} name */
function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new SmithersError("INVALID_INPUT", `${name} must be a positive integer.`);
  }
  return Number(value);
}

/** @param {TrellisProps["limits"]} limits */
function normalizeLimits(limits) {
  const next = { ...DEFAULT_LIMITS, ...(limits ?? {}) };
  for (const [name, value] of Object.entries(next)) positiveInteger(value, `Trellis limits.${name}`);
  return next;
}

/** @param {unknown} agent @param {string} role */
function requireAgent(agent, role) {
  const chain = Array.isArray(agent) ? agent : [agent];
  if (chain.length === 0 || chain.some((entry) => !entry || typeof entry.generate !== "function")) {
    throw new SmithersError("INVALID_INPUT", `Trellis requires an agent or failover chain for role ${role}.`);
  }
  return agent;
}

/** @param {string[]} values */
function unique(values) {
  return [...new Set(values)];
}

/** @param {string} prefix @param {string} invocationKey */
function finalNodeId(prefix, invocationKey) {
  const id = `${prefix}:final:${hashStableValue({ type: "trellis-final", invocationKey }).slice(0, 24)}`;
  if (!isGatewaySafeNodeId(id)) {
    throw new SmithersError("INVALID_INPUT", "Trellis idPrefix must produce gateway-safe node ids.");
  }
  return id;
}

/** @param {unknown} value */
function summaryOf(value) {
  if (value && typeof value === "object" && typeof value.summary === "string") return value.summary;
  return undefined;
}

/** @param {unknown} value */
function failureMessage(value) {
  if (value instanceof Error) return value.message.slice(0, 2_048);
  if (value && typeof value === "object" && typeof value.message === "string") return value.message.slice(0, 2_048);
  return String(value ?? "Agent task failed before producing a valid envelope.").slice(0, 2_048);
}

/** @param {Record<string, any>} ctx @param {string} nodeId */
function taskFailureFor(ctx, nodeId) {
  const runtime = ctx?.__smithersRuntime;
  const states = runtime?.taskStates;
  if (!(states instanceof Map)) return undefined;
  const scopes = [...(ctx?._currentScopes ?? [])];
  let selectedKey;
  let selectedState;
  for (const [key, state] of states) {
    if (typeof key !== "string") continue;
    const separator = key.lastIndexOf("::");
    const physicalId = separator >= 0 ? key.slice(0, separator) : key;
    const suffix = physicalId.slice(nodeId.length);
    if (physicalId !== nodeId && !(physicalId.startsWith(`${nodeId}@@`) && scopes.includes(suffix))) continue;
    selectedKey = key;
    selectedState = state;
  }
  if (selectedState === "cancelled") {
    return { code: "cancelled", message: "Agent task was cancelled before producing a valid envelope." };
  }
  if (selectedState !== "failed") return undefined;
  const failure = runtime.taskFailures instanceof Map ? runtime.taskFailures.get(selectedKey) : undefined;
  const failureCode = failure && typeof failure === "object" ? failure.code : undefined;
  const code =
    failureCode === "TASK_TIMEOUT" || failureCode === "TASK_HEARTBEAT_TIMEOUT"
      ? "timeout"
      : failureCode === "INVALID_OUTPUT"
        ? "invalid_return"
        : "crash";
  return { code, message: failureMessage(failure) };
}

/** @param {Record<string, any>} ctx @param {number} declaredMaxConcurrency */
function assertRuntimePolicy(ctx, declaredMaxConcurrency) {
  const runtime = ctx?.__smithersRuntime;
  if (!runtime) return;
  if (runtime.requireRerenderOnOutputChange !== true) {
    throw new SmithersError(
      "INVALID_INPUT",
      "Trellis requires requireRerenderOnOutputChange=true for reactive settlement.",
    );
  }
  if (runtime.maxConcurrencyPinned !== true || runtime.maxConcurrency !== declaredMaxConcurrency) {
    throw new SmithersError(
      "INVALID_INPUT",
      `Trellis maxConcurrency ${declaredMaxConcurrency} must equal the explicitly pinned run maxConcurrency.`,
    );
  }
}

/**
 * @param {{ invocationKey: string, logicalId: string, generation: number, role: string, work: string, sourceNodeId: string, programDigest?: string }} identity
 * @param {"crash"|"timeout"|"invalid_return"|"cancelled"|"budget_exhausted"|"invalid_subworkflow"} code
 * @param {string} message
 */
function runtimeOutcome(identity, assignment, code, message) {
  return settleDelegationV2Envelope({
    identity,
    assignment,
    taskFailure: { code, message },
  });
}

/** @param {Record<string, any>} outcome */
function finalPayload(outcome) {
  const fuel = outcome.runtimeFailure?.code === "budget_exhausted";
  const cleanOutcome = {
    invocationKey: outcome.invocationKey,
    logicalId: outcome.logicalId,
    generation: outcome.generation,
    role: outcome.role,
    work: outcome.work,
    outputContract: outcome.outputContract,
    assignmentDigest: outcome.assignmentDigest,
    acceptanceCriterionIds: outcome.acceptanceCriterionIds,
    status: outcome.status,
    sourceNodeId: outcome.sourceNodeId,
    ...(outcome.programDigest ? { programDigest: outcome.programDigest } : {}),
    ...(outcome.product ? { product: outcome.product } : {}),
    ...(outcome.blockage ? { blockage: outcome.blockage } : {}),
    ...(outcome.runtimeFailure ? { runtimeFailure: outcome.runtimeFailure } : {}),
  };
  return {
    status: fuel ? "fuel_exhausted" : outcome.status,
    summary:
      summaryOf(outcome.product) ??
      summaryOf(outcome.blockage) ??
      outcome.runtimeFailure?.message ??
      "Trellis finished without a summary.",
    outcome: cleanOutcome,
  };
}

/** @param {unknown} value */
function nullable(value) {
  return value === undefined ? null : value;
}

/** @param {unknown} agent */
function agentFingerprint(agent) {
  const chain = Array.isArray(agent) ? agent : [agent];
  return chain.map((entry) => ({
    kind: entry?.constructor?.name ?? "AgentLike",
    id: entry?.constructor?.name === "Object" ? nullable(entry?.id) : null,
    version: nullable(entry?.version),
    model: nullable(entry?.model),
    systemPromptHash: typeof entry?.systemPrompt === "string" ? hashStableValue(entry.systemPrompt) : null,
    toolNames: entry?.tools && typeof entry.tools === "object" ? Object.keys(entry.tools).sort() : [],
  }));
}

/** @param {Record<string, any>} options */
function rootSemanticDigest(options) {
  return hashStableValue({
    type: "trellis-root",
    runtimeVersion: DELEGATION_V2_RUNTIME_VERSION,
    protocolVersion: DELEGATION_V2_PROTOCOL_VERSION,
    promptContractVersion: DELEGATION_V2_PROMPT_CONTRACT_VERSION,
    registryVersion: DELEGATION_V2_REGISTRY_VERSION,
    compilerVersion: DELEGATION_V2_COMPILER_VERSION,
    role: options.role,
    work: options.work,
    outputContract: options.outputContract,
    goal: options.goal,
    instructions: options.instructions,
    acceptance: options.acceptance,
    limits: options.limits,
    maxConcurrency: options.maxConcurrency,
    criticalExecutionPolicy: options.criticalExecutionPolicy,
    criticalReviewIndependentRoles: options.criticalReviewIndependentRoles,
    semanticRevision: options.semanticRevision,
    agents: Object.fromEntries(
      ["sol", "fable", "terra", "luna"].map((role) => [role, agentFingerprint(options.agents[role])]),
    ),
  });
}

/** @param {unknown} left @param {unknown} right */
function sameProgramRef(left, right) {
  return Boolean(
    left &&
    right &&
    typeof left === "object" &&
    typeof right === "object" &&
    left.id === right.id &&
    left.digest === right.digest,
  );
}

const REPAIR_TOPOLOGY_CODES = new Set([
  "node_limit",
  "depth_limit",
  "fanout_limit",
  "unsupported_nested_concurrency",
  "parallel_write_conflict",
  "author_fuel_limit",
  "author_depth_limit",
]);

const PRUNABLE_AUTHOR_TOPOLOGY_CODES = new Set(["author_fuel_limit", "author_depth_limit"]);

/** @param {unknown} value */
function jsonRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

/** @param {unknown} left @param {unknown} right */
function sameJson(left, right) {
  try {
    return hashStableValue(left) === hashStableValue(right);
  } catch {
    return false;
  }
}

/** @param {string} path */
function repairPath(path) {
  const parts = String(path).split(".").filter(Boolean);
  return parts[0] === "root" ? parts.slice(1) : parts;
}

/** @param {readonly string[]} path @param {readonly string[]} prefix */
function pathWithin(path, prefix) {
  return prefix.length <= path.length && prefix.every((part, index) => path[index] === part);
}

/** @param {readonly string[]} left @param {readonly string[]} right */
function sameRepairPath(left, right) {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

/** @param {readonly string[]} path */
function isTopologyArrayPath(path) {
  return path.at(-1) === "steps" || path.at(-1) === "branches";
}

/**
 * Return leaf-level changes without recursively parsing through Zod. Author
 * capture bounds make this walk finite even for a rejected hostile proposal.
 * @param {unknown} left
 * @param {unknown} right
 * @param {string[]} [base]
 */
function changedJsonPaths(left, right, base = []) {
  const changed = [];
  const stack = [{ left, right, path: base }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (Object.is(current.left, current.right)) continue;
    const leftObject = current.left && typeof current.left === "object";
    const rightObject = current.right && typeof current.right === "object";
    if (!leftObject || !rightObject || Array.isArray(current.left) !== Array.isArray(current.right)) {
      changed.push(current.path);
      continue;
    }
    const leftRecord = current.left;
    const rightRecord = current.right;
    const keys = new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)]);
    for (const key of keys) {
      if (!Object.hasOwn(leftRecord, key) || !Object.hasOwn(rightRecord, key)) {
        changed.push([...current.path, key]);
      } else {
        stack.push({ left: leftRecord[key], right: rightRecord[key], path: [...current.path, key] });
      }
    }
  }
  return changed;
}

/** @param {unknown} rawProgram */
function collectRepairNodes(rawProgram) {
  const program = jsonRecord(rawProgram);
  const root = jsonRecord(program?.root);
  if (!root) return [];
  const entries = [];
  const stack = [{ node: root, path: ["root"] }];
  while (stack.length > 0) {
    const entry = stack.pop();
    entries.push(entry);
    for (const key of ["branches", "steps"]) {
      const children = entry.node[key];
      if (!Array.isArray(children)) continue;
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = jsonRecord(children[index]);
        if (child) stack.push({ node: child, path: [...entry.path, key, String(index)] });
      }
    }
  }
  return entries;
}

/** @param {Record<string, unknown>} node */
function nodeWithoutTopology(node) {
  const { branches: _branches, steps: _steps, ...rest } = node;
  return rest;
}

/**
 * Reference fields can require exact mechanical rewrites after a unique id or
 * contract repair. Ignore them only while pairing occurrences; the final
 * integrity pass derives and checks every transformed reference exactly.
 * @param {Record<string, unknown>} node
 */
function nodeForRepairMatching(node) {
  const { inputs: _inputs, ...rest } = nodeWithoutTopology(node);
  const prompt = jsonRecord(rest.prompt);
  const criticality = jsonRecord(rest.criticality);
  if (prompt) {
    const { contextRefs: _contextRefs, ...promptRest } = prompt;
    rest.prompt = promptRest;
  }
  if (criticality) {
    const {
      reviewNodeId: _reviewNodeId,
      surroundingWorkDelegatedTo: _surroundingWorkDelegatedTo,
      ...criticalityRest
    } = criticality;
    rest.criticality = criticalityRest;
  }
  return rest;
}

/** @param {Record<string, unknown>} node */
function repairReferenceSignature(node) {
  const prompt = jsonRecord(node.prompt);
  const criticality = jsonRecord(node.criticality);
  return {
    inputs: nullable(node.inputs),
    contextRefs: nullable(prompt?.contextRefs),
    reviewNodeId: nullable(criticality?.reviewNodeId),
    surroundingWorkDelegatedTo: nullable(criticality?.surroundingWorkDelegatedTo),
  };
}

/**
 * @param {Record<string, unknown>} node
 * @param {Map<string, string>} idChanges
 * @param {Map<string, string>} contractChanges
 * @param {Set<string>} removed
 */
function transformedRepairReferenceSignature(node, idChanges, contractChanges, removed) {
  const prompt = jsonRecord(node.prompt);
  const criticality = jsonRecord(node.criticality);
  const contextRefs = Array.isArray(prompt?.contextRefs)
    ? prompt.contextRefs
        .filter((ref) => typeof ref !== "string" || !removed.has(ref))
        .map((ref) => (typeof ref === "string" ? (idChanges.get(ref) ?? ref) : ref))
    : prompt?.contextRefs;
  const reviewNodeId =
    typeof criticality?.reviewNodeId === "string"
      ? (idChanges.get(criticality.reviewNodeId) ?? criticality.reviewNodeId)
      : criticality?.reviewNodeId;
  const surroundingWorkDelegatedTo = Array.isArray(criticality?.surroundingWorkDelegatedTo)
    ? criticality.surroundingWorkDelegatedTo
        .filter((id) => typeof id !== "string" || !removed.has(id))
        .map((id) => (typeof id === "string" ? (idChanges.get(id) ?? id) : id))
    : criticality?.surroundingWorkDelegatedTo;
  return {
    inputs: nullable(transformedRefs(node.inputs, idChanges, contractChanges, removed)),
    contextRefs: nullable(contextRefs),
    reviewNodeId: nullable(reviewNodeId),
    surroundingWorkDelegatedTo: nullable(surroundingWorkDelegatedTo),
  };
}

/** @param {unknown} refs @param {Map<string, string>} idChanges @param {Map<string, string>} contractChanges @param {Set<string>} removed */
function transformedRefs(refs, idChanges, contractChanges, removed) {
  if (!Array.isArray(refs)) return refs;
  return refs.flatMap((raw) => {
    const ref = jsonRecord(raw);
    if (!ref || typeof ref.from !== "string") return [raw];
    if (removed.has(ref.from)) return [];
    return [
      {
        ...ref,
        from: idChanges.get(ref.from) ?? ref.from,
        ...(typeof ref.contract === "string" ? { contract: contractChanges.get(ref.from) ?? ref.contract } : {}),
      },
    ];
  });
}

/** @param {unknown} refs */
function sortedRefs(refs) {
  if (!Array.isArray(refs)) return refs;
  return [...refs].sort((left, right) => {
    const leftKey = `${left?.from ?? ""}\u0000${left?.contract ?? ""}\u0000${left?.purpose ?? ""}`;
    const rightKey = `${right?.from ?? ""}\u0000${right?.contract ?? ""}\u0000${right?.purpose ?? ""}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

/**
 * Enforce that a semantic-repair turn is a patch, not a second planning turn.
 * Validator paths authorize the exact invalid fragments. Structural-limit
 * diagnostics may only prune/re-parent already-authored nodes, and reference
 * fields may only follow an authorized id/contract change.
 *
 * @param {{
 *   rejectedProgram: unknown,
 *   repairedProgram: unknown,
 *   diagnostics: Array<{code?: string, path?: string, message?: string}>,
 *   rejectedState?: unknown,
 *   repairedState?: unknown,
 * }} options
 */
export function validateDelegationV2RepairIntegrity(options) {
  const rejected = jsonRecord(options.rejectedProgram);
  const repaired = jsonRecord(options.repairedProgram);
  const fail = (path, message) => ({
    ok: false,
    diagnostics: [{ code: "schema_invalid", path, message }],
  });
  if (!rejected || !repaired) {
    return fail("root", "Semantic repair requires both the captured rejected program and a corrected program object.");
  }
  if (options.rejectedState !== undefined && !sameJson(options.rejectedState, options.repairedState)) {
    return fail("root.state", "Semantic repair cannot rewrite the author's continuation state.");
  }

  const rejectedNodes = collectRepairNodes(rejected);
  const rejectedById = new Map();
  const rejectedByPath = new Map();
  for (const entry of rejectedNodes) {
    if (typeof entry.node.id === "string") {
      const entries = rejectedById.get(entry.node.id) ?? [];
      entries.push(entry);
      rejectedById.set(entry.node.id, entries);
    }
    rejectedByPath.set(entry.path.join("."), entry);
  }
  const firstRejectedAgentById = new Map();
  for (const entry of rejectedNodes) {
    if (entry.node.tag === "agent" && typeof entry.node.id === "string" && !firstRejectedAgentById.has(entry.node.id)) {
      firstRejectedAgentById.set(entry.node.id, entry);
    }
  }
  const diagnosticRoots = [];
  const structuralRoots = [];
  const topologyScalarRoots = [];
  const authorTopologyRoots = [];
  const removableAuthorRoots = [];
  const reviewJoinDiagnostics = [];
  /** @param {{node: Record<string, unknown>, path: string[]}} entry */
  const authorizeAuthorRepair = (entry) => {
    if (entry.node.tag !== "agent" || !AUTHOR_ROLES.has(entry.node.role)) return;
    removableAuthorRoots.push(entry.path);
    diagnosticRoots.push([...entry.path, "role"]);
    const containerIndex = Math.max(entry.path.lastIndexOf("steps"), entry.path.lastIndexOf("branches"));
    if (containerIndex >= 0) authorTopologyRoots.push(entry.path.slice(0, containerIndex + 1));
  };
  for (const diagnostic of options.diagnostics) {
    const root = repairPath(diagnostic.path ?? "root");
    if (PRUNABLE_AUTHOR_TOPOLOGY_CODES.has(diagnostic.code)) {
      if (diagnostic.code === "author_fuel_limit") {
        // Fuel is an aggregate diagnostic, so its exact repair candidates are
        // every authored Sol/Fable leaf -- never their Terra/Luna siblings.
        for (const entry of rejectedNodes) authorizeAuthorRepair(entry);
      } else {
        const path = root.at(-1) === "role" ? root.slice(0, -1) : root;
        const pathEntry = rejectedByPath.get(path.join("."));
        // Validator paths identify the exact occurrence even when hostile IR
        // repeats an id. nodeId is only a consistency check, or a unique
        // fallback for older persisted diagnostics that lack a usable path.
        let entry =
          pathEntry && (typeof diagnostic.nodeId !== "string" || pathEntry.node.id === diagnostic.nodeId)
            ? pathEntry
            : undefined;
        if (!pathEntry && typeof diagnostic.nodeId === "string") {
          const candidates = rejectedById.get(diagnostic.nodeId) ?? [];
          if (candidates.length === 1) [entry] = candidates;
        }
        if (entry) authorizeAuthorRepair(entry);
      }
    } else if (REPAIR_TOPOLOGY_CODES.has(diagnostic.code)) {
      if (root.length === 1 || root.at(-1) === "steps" || root.at(-1) === "branches") {
        structuralRoots.push(root);
      } else {
        // A topology diagnostic may target scalar topology metadata such as
        // maxConcurrency. Keep that authority exact and separate from content.
        topologyScalarRoots.push(root);
      }
    } else if (diagnostic.code === "critical_review_not_joined") {
      reviewJoinDiagnostics.push(diagnostic);
    } else if (diagnostic.code === "total_prompt_limit") {
      // This is an aggregate byte-limit diagnostic, not authority over the
      // whole program. Any existing agent prompt may be shortened to satisfy
      // it, while ids, assignments, goals, topology, and outputs stay pinned.
      for (const entry of rejectedNodes) {
        if (entry.node.tag === "agent") {
          diagnosticRoots.push([...entry.path, "prompt", "instructions"]);
        }
      }
    }
    const unknownKeys =
      diagnostic.code === "schema_invalid" && /Unrecognized key/.test(diagnostic.message ?? "")
        ? [...String(diagnostic.message).matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)].map((match) => match[1])
        : [];
    if (unknownKeys.length > 0) {
      for (const key of unknownKeys) diagnosticRoots.push([...root, key]);
    } else if (
      !PRUNABLE_AUTHOR_TOPOLOGY_CODES.has(diagnostic.code) &&
      !REPAIR_TOPOLOGY_CODES.has(diagnostic.code) &&
      diagnostic.code !== "critical_review_not_joined" &&
      diagnostic.code !== "total_prompt_limit"
    ) {
      diagnosticRoots.push(root);
    }
  }
  // Array-valued structural authority is exact. A diagnostic already ending
  // in `.steps`/`.branches` owns only that array. The aggregate root-level
  // node/depth diagnostics own only the root container's direct array, not
  // every descendant array beneath it.
  const structuralArrayRoots = structuralRoots.flatMap((root) =>
    isTopologyArrayPath(root)
      ? [root]
      : [
          [...root, "steps"],
          [...root, "branches"],
        ],
  );
  const directlyAllowed = (path) => diagnosticRoots.some((root) => pathWithin(path, root));
  const topologyScalarAllowed = (path) => topologyScalarRoots.some((root) => pathWithin(path, root));
  const topologyAllowed = (path) =>
    topologyScalarAllowed(path) ||
    (path[0] === "root" &&
      path.some((part) => part === "steps" || part === "branches") &&
      [...structuralArrayRoots, ...authorTopologyRoots].some((root) => pathWithin(path, root)));
  const directStructuralRemovalAllowed = (path) =>
    structuralArrayRoots.some((root) => path.length === root.length + 1 && pathWithin(path, root));
  const authorRemovalAllowed = (path) =>
    path.length > 1 && removableAuthorRoots.some((root) => sameRepairPath(path, root));

  const repairedNodes = collectRepairNodes(repaired);
  const repairedById = new Map();
  for (const entry of repairedNodes) {
    if (typeof entry.node.id === "string") {
      const entries = repairedById.get(entry.node.id) ?? [];
      entries.push(entry);
      repairedById.set(entry.node.id, entries);
    }
  }
  const repairedByPath = new Map(repairedNodes.map((entry) => [entry.path.join("."), entry]));
  const matchedRepaired = new Set();
  const matches = [];
  const removedEntries = new Set();
  const structurallyRemovedEntries = new Set();
  const matchedRawToNext = new Map();

  /**
   * Project an occurrence through removals already authorized in its exact
   * parent array. This keeps a later path-scoped id repair attached to the
   * same occurrence after an earlier sibling is pruned.
   * @param {{node: Record<string, unknown>, path: string[]}} rawEntry
   */
  const projectedPathEntry = (rawEntry) => {
    if (rawEntry.path.length < 3) return undefined;
    const parentPath = rawEntry.path.slice(0, -2);
    const key = rawEntry.path.at(-2);
    const rawIndex = Number(rawEntry.path.at(-1));
    if ((key !== "steps" && key !== "branches") || !Number.isSafeInteger(rawIndex)) return undefined;
    const rawParent = rejectedByPath.get(parentPath.join("."));
    const nextParent = rawParent ? matchedRawToNext.get(rawParent) : undefined;
    if (!nextParent) return undefined;
    let priorRemovals = 0;
    for (let index = 0; index < rawIndex; index += 1) {
      const prior = rejectedByPath.get([...parentPath, key, String(index)].join("."));
      if (prior && removedEntries.has(prior)) priorRemovals += 1;
    }
    return repairedByPath.get([...nextParent.path, key, String(rawIndex - priorRemovals)].join("."));
  };

  for (const rawEntry of rejectedNodes) {
    const rawId = typeof rawEntry.node.id === "string" ? rawEntry.node.id : undefined;
    const pathEntry = repairedByPath.get(rawEntry.path.join("."));
    const projectedEntry = projectedPathEntry(rawEntry);
    const idRepairAllowed = directlyAllowed([...rawEntry.path, "id"]);
    const compatibleIdRepairCandidate = (entry) =>
      !matchedRepaired.has(entry) &&
      changedJsonPaths(nodeForRepairMatching(rawEntry.node), nodeForRepairMatching(entry.node)).every((relative) =>
        directlyAllowed([...rawEntry.path, ...relative]),
      );
    let nextEntry;
    if (rawId) {
      const sameIdEntries = (repairedById.get(rawId) ?? []).filter((entry) => !matchedRepaired.has(entry));
      if (sameIdEntries.length === 1) [nextEntry] = sameIdEntries;
      else if (pathEntry && sameIdEntries.includes(pathEntry)) nextEntry = pathEntry;
    }
    if (!nextEntry && idRepairAllowed) {
      const compatibleCandidates = repairedNodes.filter(compatibleIdRepairCandidate);
      const provisionalIdChanges = new Map();
      const provisionalContractChanges = new Map();
      const provisionallyRemovedIds = new Set();
      for (const [id, entries] of rejectedById) {
        if (entries.every((entry) => removedEntries.has(entry))) provisionallyRemovedIds.add(id);
      }
      for (const [matchedRaw, matchedNext] of matchedRawToNext) {
        const matchedId = typeof matchedRaw.node.id === "string" ? matchedRaw.node.id : undefined;
        if (!matchedId || rejectedById.get(matchedId)?.length !== 1) continue;
        if (typeof matchedNext.node.id === "string" && matchedNext.node.id !== matchedId) {
          provisionalIdChanges.set(matchedId, matchedNext.node.id);
        }
        if (
          typeof matchedRaw.node.outputContract === "string" &&
          typeof matchedNext.node.outputContract === "string" &&
          matchedNext.node.outputContract !== matchedRaw.node.outputContract &&
          directlyAllowed([...matchedRaw.path, "outputContract"])
        ) {
          provisionalContractChanges.set(matchedId, matchedNext.node.outputContract);
        }
      }
      const expectedReferences = transformedRepairReferenceSignature(
        rawEntry.node,
        provisionalIdChanges,
        provisionalContractChanges,
        provisionallyRemovedIds,
      );
      const referenceCompatible = compatibleCandidates.filter((entry) =>
        sameJson(expectedReferences, repairReferenceSignature(entry.node)),
      );
      if (referenceCompatible.length === 1) {
        [nextEntry] = referenceCompatible;
      } else if (referenceCompatible.length > 1) {
        if (projectedEntry && referenceCompatible.includes(projectedEntry)) nextEntry = projectedEntry;
        else if (pathEntry && referenceCompatible.includes(pathEntry)) nextEntry = pathEntry;
      } else if (compatibleCandidates.length === 1) {
        [nextEntry] = compatibleCandidates;
      } else if (
        projectedEntry &&
        compatibleCandidates.includes(projectedEntry) &&
        compatibleCandidates.every((entry) =>
          sameJson(repairReferenceSignature(entry.node), repairReferenceSignature(projectedEntry.node)),
        )
      ) {
        nextEntry = projectedEntry;
      }
    }
    if (!nextEntry) {
      const removedStructuralAncestor = [...structurallyRemovedEntries].some((entry) =>
        pathWithin(rawEntry.path, entry.path),
      );
      if (
        directStructuralRemovalAllowed(rawEntry.path) ||
        removedStructuralAncestor ||
        authorRemovalAllowed(rawEntry.path)
      ) {
        removedEntries.add(rawEntry);
        if (directStructuralRemovalAllowed(rawEntry.path) || removedStructuralAncestor) {
          structurallyRemovedEntries.add(rawEntry);
        }
        continue;
      }
      return fail(
        `root.${rawEntry.path.join(".")}`,
        `Semantic repair removed valid node ${rawId ?? rawEntry.path.join(".")}.`,
      );
    }
    matchedRepaired.add(nextEntry);
    matches.push([rawEntry, nextEntry]);
    matchedRawToNext.set(rawEntry, nextEntry);
  }

  const broadRootRepair =
    rejectedNodes.length === 0 && diagnosticRoots.some((root) => root.length === 1 && root[0] === "root");
  for (const entry of repairedNodes) {
    if (!matchedRepaired.has(entry) && !broadRootRepair) {
      return fail(
        `root.${entry.path.join(".")}`,
        `Semantic repair introduced unrequested node ${String(entry.node.id ?? entry.path.join("."))}.`,
      );
    }
  }

  const rawToNext = new Map(matches);
  const nextToRaw = new Map(matches.map(([rawEntry, nextEntry]) => [nextEntry, rawEntry]));
  // Compare every preserved parent/child edge compositionally. Exact author
  // removal is projected out, but no descendant can move or reorder merely
  // because an ancestor's author slot was diagnosed. Only a structural root
  // that independently owns the particular array suspends this invariant.
  for (const [rawEntry, nextEntry] of matches) {
    for (const key of ["branches", "steps"]) {
      const topologyRoot = [...rawEntry.path, key];
      if (structuralArrayRoots.some((root) => sameRepairPath(topologyRoot, root))) continue;
      const rawChildren = rawEntry.node[key];
      const nextChildren = nextEntry.node[key];
      if (!Array.isArray(rawChildren) && !Array.isArray(nextChildren)) continue;
      const projected = Array.isArray(rawChildren)
        ? rawChildren.flatMap((_child, index) => {
            const child = rejectedByPath.get([...rawEntry.path, key, String(index)].join("."));
            return child && !removedEntries.has(child) ? [child] : [];
          })
        : rawChildren;
      const actual = Array.isArray(nextChildren)
        ? nextChildren.map((_child, index) => {
            const child = repairedByPath.get([...nextEntry.path, key, String(index)].join("."));
            return child ? nextToRaw.get(child) : undefined;
          })
        : nextChildren;
      if (
        !Array.isArray(projected) ||
        !Array.isArray(actual) ||
        projected.length !== actual.length ||
        projected.some((entry, index) => entry !== actual[index])
      ) {
        return fail(
          `root.${rawEntry.path.join(".")}.${key}`,
          "Semantic repair cannot reorder, re-parent, or remove preserved siblings without an independently diagnosed structural root.",
        );
      }
    }
  }

  const removedIds = new Set();
  const idChanges = new Map();
  const contractChanges = new Map();
  for (const [id, entries] of rejectedById) {
    if (entries.every((entry) => removedEntries.has(entry))) removedIds.add(id);
  }
  for (const [rawEntry, nextEntry] of matches) {
    const rawId = typeof rawEntry.node.id === "string" ? rawEntry.node.id : undefined;
    // References cannot identify one occurrence of a duplicated hostile id.
    // Only propagate changes from ids that were unique in the rejected graph.
    if (!rawId || rejectedById.get(rawId)?.length !== 1) continue;
    if (typeof nextEntry.node.id === "string" && rawId !== nextEntry.node.id) {
      idChanges.set(rawId, nextEntry.node.id);
    }
    if (
      typeof rawEntry.node.outputContract === "string" &&
      typeof nextEntry.node.outputContract === "string" &&
      rawEntry.node.outputContract !== nextEntry.node.outputContract &&
      directlyAllowed([...rawEntry.path, "outputContract"])
    ) {
      contractChanges.set(rawId, nextEntry.node.outputContract);
    }
  }

  const necessaryRoots = [["supersedes"]];
  const expectedOutputs = sortedRefs(transformedRefs(rejected.outputs, idChanges, contractChanges, removedIds));
  const requiredReviewEntries = [];
  for (const diagnostic of reviewJoinDiagnostics) {
    const root = repairPath(diagnostic.path ?? "root");
    const executePath = root.at(-1) === "reviewNodeId" && root.at(-2) === "criticality" ? root.slice(0, -2) : root;
    const pathEntry = rejectedByPath.get(executePath.join("."));
    let executeEntry =
      pathEntry && (typeof diagnostic.nodeId !== "string" || pathEntry.node.id === diagnostic.nodeId)
        ? pathEntry
        : undefined;
    if (!pathEntry && typeof diagnostic.nodeId === "string") {
      const candidates = rejectedById.get(diagnostic.nodeId) ?? [];
      if (candidates.length === 1) [executeEntry] = candidates;
    }
    const reviewerId = executeEntry?.node?.criticality?.reviewNodeId;
    // Validation resolves references through the first agent occurrence for
    // an id, even when hostile IR also contains a later duplicate. Mirror
    // that deterministic occurrence rule, then re-check the review edge so a
    // duplicate id can never authorize an unrelated output.
    const reviewerEntry = typeof reviewerId === "string" ? firstRejectedAgentById.get(reviewerId) : undefined;
    const consumesExecution = reviewerEntry?.node?.inputs?.some(
      (input) => input?.from === executeEntry?.node?.id && input?.contract === executeEntry?.node?.outputContract,
    );
    if (!reviewerEntry || reviewerEntry.node.work !== "review" || reviewerEntry === executeEntry || !consumesExecution)
      continue;
    const repairedReviewer = rawToNext.get(reviewerEntry);
    if (typeof repairedReviewer?.node?.id !== "string" || typeof repairedReviewer.node.outputContract !== "string")
      continue;
    if (!requiredReviewEntries.includes(reviewerEntry)) requiredReviewEntries.push(reviewerEntry);
  }
  if (Array.isArray(expectedOutputs) && Array.isArray(repaired.outputs)) {
    const ancestorCache = new Map();
    /** @param {{node: Record<string, unknown>, path: string[]}} entry @param {Set<unknown>} [active] */
    const inputAncestorEntries = (entry, active = new Set()) => {
      const cached = ancestorCache.get(entry);
      if (cached) return cached;
      if (active.has(entry)) return new Set();
      active.add(entry);
      const result = new Set();
      for (const input of Array.isArray(entry.node.inputs) ? entry.node.inputs : []) {
        const source = typeof input?.from === "string" ? firstRejectedAgentById.get(input.from) : undefined;
        if (!source) continue;
        result.add(source);
        for (const ancestor of inputAncestorEntries(source, active)) result.add(ancestor);
      }
      active.delete(entry);
      ancestorCache.set(entry, result);
      return result;
    };
    const candidateCoverage = [];
    for (const [rawEntry, nextEntry] of matches) {
      if (
        rawEntry.node.tag !== "agent" ||
        typeof nextEntry.node.id !== "string" ||
        typeof nextEntry.node.outputContract !== "string"
      )
        continue;
      const ancestors = inputAncestorEntries(rawEntry);
      const covers = requiredReviewEntries.filter((reviewer) => rawEntry === reviewer || ancestors.has(reviewer));
      if (covers.length === 0) continue;
      const ref = { from: nextEntry.node.id, contract: nextEntry.node.outputContract };
      const prior = candidateCoverage.find((candidate) => sameJson(candidate.ref, ref));
      if (prior) for (const reviewer of covers) prior.covers.add(reviewer);
      else candidateCoverage.push({ ref, covers: new Set(covers) });
    }
    const coverageForRef = (ref) =>
      candidateCoverage.find((candidate) => sameJson(candidate.ref, ref))?.covers ?? new Set();
    const remainingOutputs = [...repaired.outputs];
    let exactExpectedOutputs = true;
    for (const expected of expectedOutputs) {
      const index = remainingOutputs.findIndex((actual) => sameJson(actual, expected));
      if (index < 0) {
        exactExpectedOutputs = false;
        break;
      }
      remainingOutputs.splice(index, 1);
    }
    const allRecognized =
      exactExpectedOutputs &&
      remainingOutputs.every((ref) => candidateCoverage.some((candidate) => sameJson(candidate.ref, ref)));
    const coveredWithout = (omittedExtraIndex = -1) => {
      const covered = new Set();
      for (const ref of expectedOutputs) for (const reviewer of coverageForRef(ref)) covered.add(reviewer);
      remainingOutputs.forEach((ref, index) => {
        if (index === omittedExtraIndex) return;
        for (const reviewer of coverageForRef(ref)) covered.add(reviewer);
      });
      return requiredReviewEntries.every((reviewer) => covered.has(reviewer));
    };
    const allRequiredJoined = coveredWithout();
    const noRedundantExtra = remainingOutputs.every((_ref, index) => !coveredWithout(index));
    if (allRecognized && allRequiredJoined && noRedundantExtra) {
      necessaryRoots.push(["outputs"]);
    }
  }

  for (const [rawEntry, nextEntry] of matches) {
    const rawInputs = rawEntry.node.inputs;
    const expectedInputs = transformedRefs(rawInputs, idChanges, contractChanges, removedIds);
    if (sameJson(expectedInputs, nextEntry.node.inputs)) necessaryRoots.push([...rawEntry.path, "inputs"]);
    const contextRefs = rawEntry.node.prompt?.contextRefs;
    if (Array.isArray(contextRefs)) {
      const expectedContext = contextRefs
        .filter((ref) => typeof ref !== "string" || !removedIds.has(ref))
        .map((ref) => (typeof ref === "string" ? (idChanges.get(ref) ?? ref) : ref));
      if (sameJson(expectedContext, nextEntry.node.prompt?.contextRefs)) {
        necessaryRoots.push([...rawEntry.path, "prompt", "contextRefs"]);
      }
    }
    const reviewId = rawEntry.node.criticality?.reviewNodeId;
    if (
      typeof reviewId === "string" &&
      idChanges.has(reviewId) &&
      nextEntry.node.criticality?.reviewNodeId === idChanges.get(reviewId)
    ) {
      necessaryRoots.push([...rawEntry.path, "criticality", "reviewNodeId"]);
    }
    const delegatedIds = rawEntry.node.criticality?.surroundingWorkDelegatedTo;
    if (Array.isArray(delegatedIds)) {
      const expectedDelegatedIds = delegatedIds
        .filter((id) => typeof id !== "string" || !removedIds.has(id))
        .map((id) => (typeof id === "string" ? (idChanges.get(id) ?? id) : id));
      if (sameJson(expectedDelegatedIds, nextEntry.node.criticality?.surroundingWorkDelegatedTo)) {
        necessaryRoots.push([...rawEntry.path, "criticality", "surroundingWorkDelegatedTo"]);
      }
    }
  }
  const necessaryAllowed = (path) => necessaryRoots.some((root) => pathWithin(path, root));

  for (const path of changedJsonPaths(rejected, repaired)) {
    if (directlyAllowed(path) || necessaryAllowed(path) || topologyAllowed(path)) continue;
    return fail(
      `root.${path.join(".") || "program"}`,
      `Semantic repair changed undiagnosed fragment ${path.join(".") || "program"}.`,
    );
  }
  for (const [rawEntry, nextEntry] of matches) {
    for (const relative of changedJsonPaths(nodeWithoutTopology(rawEntry.node), nodeWithoutTopology(nextEntry.node))) {
      const path = [...rawEntry.path, ...relative];
      if (directlyAllowed(path) || necessaryAllowed(path) || topologyScalarAllowed(path)) continue;
      return fail(`root.${path.join(".")}`, `Semantic repair changed valid node fragment ${path.join(".")}.`);
    }
  }
  return { ok: true, diagnostics: [] };
}

/** @param {unknown} rawProgram @param {string} digest */
function rejectedProgramRef(rawProgram, digest) {
  const candidate = localIdSchema.safeParse(jsonRecord(rawProgram)?.id);
  return {
    id: candidate.success ? candidate.data : `invalid-${digest.slice(0, 24)}`,
    digest,
  };
}

/**
 * Apply history rules that cannot be validated from one isolated program.
 * @param {ReturnType<typeof validateWorkflowProgram>} result
 * @param {{ id: string, digest: string }[]} acceptedRefs
 * @param {{ id: string, digest: string } | undefined} requiredSupersedes
 */
function enforceSupersession(result, acceptedRefs, requiredSupersedes) {
  if (!result.ok || !result.normalizedProgram) return result;
  const actual = result.normalizedProgram.supersedes;
  const valid = requiredSupersedes
    ? sameProgramRef(actual, requiredSupersedes)
    : !actual || acceptedRefs.some((candidate) => sameProgramRef(actual, candidate));
  if (valid) return result;
  return {
    ...result,
    ok: false,
    status: "rejected",
    normalizedProgram: undefined,
    diagnostics: [
      {
        code: "schema_invalid",
        path: "root.supersedes",
        message: requiredSupersedes
          ? "Semantic repair must supersede the exact rejected program id and digest."
          : "supersedes must reference an accepted program from this invocation's immutable history.",
      },
    ],
  };
}

/**
 * @param {ReturnType<typeof validateWorkflowProgram>} result
 * @param {{invocationKey: string, generation: number, authorNodeId: string}} identity
 * @param {Record<string, any> | null | undefined} [criticalExecutionPolicy]
 */
function validationPayload(result, identity, criticalExecutionPolicy) {
  return {
    ...identity,
    status: result.status,
    programDigest: result.programDigest,
    registryVersion: DELEGATION_V2_REGISTRY_VERSION,
    compilerVersion: DELEGATION_V2_COMPILER_VERSION,
    ...(criticalExecutionPolicy?.policyHash ? { criticalExecutionPolicyHash: criticalExecutionPolicy.policyHash } : {}),
    ...(result.ok ? { normalizedProgram: result.normalizedProgram } : {}),
    diagnostics: result.diagnostics,
    stats: result.stats,
  };
}

/**
 * @param {Record<string, any>} authority
 * @param {string} prompt
 * @param {Record<string, any>} fields
 */
function trellisMeta(authority, prompt, fields) {
  return {
    trellis: {
      namespace: "trellis",
      protocolVersion: DELEGATION_V2_PROTOCOL_VERSION,
      promptContractVersion: DELEGATION_V2_PROMPT_CONTRACT_VERSION,
      registryVersion: DELEGATION_V2_REGISTRY_VERSION,
      compilerVersion: DELEGATION_V2_COMPILER_VERSION,
      authorityHash: hashStableValue(authority),
      ...(authority.criticalExecutionPolicy?.policyHash
        ? { criticalExecutionPolicyHash: authority.criticalExecutionPolicy.policyHash }
        : {}),
      ...(authority.criticalExecutionGrant?.grantHash
        ? { criticalExecutionGrantHash: authority.criticalExecutionGrant.grantHash }
        : {}),
      ...(prompt ? { promptHash: hashStableValue(prompt) } : {}),
      ...fields,
    },
  };
}

/**
 * Persist caller-owned run limits separately from model-authored output. Author
 * fuel below the root is an immutable subtree allocation, so local remaining
 * fuel is deliberately named as invocation-local rather than run-global.
 * @param {{
 *   rootMaxConcurrency: number,
 *   limits: Record<string, number>,
 *   invocationAuthorTurnsAllocated?: number,
 *   invocationAuthorTurnsRemaining?: number,
 * }} options
 */
function runTruthFields(options) {
  return {
    rootMaxConcurrency: options.rootMaxConcurrency,
    rootAuthorTurnsTotal: options.limits.maxTotalAuthorTurns,
    rootMaxAuthorGenerations: options.limits.maxAuthorGenerations,
    rootMaxAuthorDepth: options.limits.maxAuthorDepth,
    ...(options.invocationAuthorTurnsAllocated === undefined
      ? {}
      : { invocationAuthorTurnsAllocated: options.invocationAuthorTurnsAllocated }),
    ...(options.invocationAuthorTurnsRemaining === undefined
      ? {}
      : { invocationAuthorTurnsRemaining: options.invocationAuthorTurnsRemaining }),
  };
}

/**
 * @param {{
 *   role: string, work: string, invocationKey: string, logicalId: string,
 *   generation: number, parentInvocationKey?: string, authorDepth: number,
 *   canAuthorSubworkflow: boolean, allowAuthorChildren?: boolean,
 *   criticalExecutionGrant?: Record<string, any> | null,
 *   criticalExecutionPolicy?: Record<string, any> | null,
 *   criticalReviewIndependentRoles?: {sol: string[], fable: string[]},
 *   hasCappedParallelAncestor?: boolean,
 *   limits: Record<string, number>, rootMaxConcurrency: number,
 *   authorTurnsRemaining: number,
 *   repair?: boolean,
 * }} opts
 */
function authorityFor(opts) {
  const allowAuthorChildren = opts.allowAuthorChildren !== false;
  const criticalExecutionGrant = opts.criticalExecutionGrant ?? null;
  return {
    protocolVersion: DELEGATION_V2_PROTOCOL_VERSION,
    role: opts.role,
    workKind: opts.work,
    actor: {
      logicalNodeId: opts.logicalId,
      invocationKey: opts.invocationKey,
      generation: opts.generation,
    },
    parentInvocationKey: opts.parentInvocationKey ?? null,
    canAuthorSubworkflow: opts.canAuthorSubworkflow,
    hasCappedParallelAncestor: opts.hasCappedParallelAncestor === true,
    allowedChildRoles: opts.canAuthorSubworkflow
      ? allowAuthorChildren
        ? ["sol", "fable", "terra", "luna"]
        : ["terra", "luna"]
      : [],
    allowedQuestionTargets: AUTHOR_ROLES.has(opts.role) ? ["parent", "human"] : ["parent"],
    questionToolAvailable: false,
    directExecutionAllowed: criticalExecutionGrant !== null,
    ...(criticalExecutionGrant ? { criticalExecutionGrant } : {}),
    ...(opts.criticalExecutionPolicy ? { criticalExecutionPolicy: opts.criticalExecutionPolicy } : {}),
    ...(opts.criticalReviewIndependentRoles
      ? { criticalReviewIndependentRoles: opts.criticalReviewIndependentRoles }
      : {}),
    ...(opts.repair ? { allowedTools: [] } : {}),
    fuel: {
      authorTurnsInSubtree: opts.authorTurnsRemaining,
      authorGenerations: Math.max(0, opts.limits.maxAuthorGenerations - opts.generation - 1),
      authorDepth: Math.max(0, opts.limits.maxAuthorDepth - opts.authorDepth - 1),
      nodesPerProgram: opts.limits.maxNodesPerProgram,
      programDepth: opts.limits.maxProgramDepth,
      fanout: opts.limits.maxFanout,
      rootMaxConcurrency: opts.rootMaxConcurrency,
    },
  };
}

/**
 * Internal recursive author invocation. Every accepted historical generation
 * remains in the returned Sequence on every render.
 * @param {Record<string, any>} props
 */
function TrellisInvocation(props) {
  const ctx = React.useContext(SmithersContext);
  const outputRows = readDelegationV2Rows(ctx, props.outputs.dv2Outcome);
  const authorRows = readDelegationV2Rows(ctx, props.outputs.dv2Author);
  const validationRows = readDelegationV2Rows(ctx, props.outputs.dv2Validation);
  const invocationOutcomeId = invocationOutcomeNodeId({ prefix: props.prefix, invocationKey: props.invocationKey });
  const lineage =
    props.authorLineage?.at(-1) === props.invocationKey
      ? props.authorLineage
      : [...(props.authorLineage ?? []), props.invocationKey];
  const trustedAssignment = {
    role: props.role,
    work: props.work,
    outputContract: props.outputContract,
    goal: props.goal,
    instructions: props.instructions,
    acceptance: props.acceptance,
    criticality: props.criticality,
    criticalExecutionGrant: props.criticalExecutionGrant,
  };
  let remainingAuthorTurns = positiveInteger(props.authorTurnBudget, `Trellis author budget for ${props.logicalId}`);

  if (props.authorDepth >= props.limits.maxAuthorDepth) {
    const exhausted = runtimeOutcome(
      {
        invocationKey: props.invocationKey,
        logicalId: props.logicalId,
        generation: 0,
        sourceNodeId: props.invocationKey,
      },
      trustedAssignment,
      "budget_exhausted",
      `Author depth limit ${props.limits.maxAuthorDepth} reached before ${props.logicalId}.`,
    );
    return React.createElement(Task, {
      id: invocationOutcomeId,
      output: props.outputs.dv2Outcome,
      dependsOn: props.entryDependsOn,
      label: `Trellis fuel exhausted: ${props.logicalId}`,
      meta: {
        trellis: {
          namespace: "trellis",
          phase: "outcome",
          logicalId: props.logicalId,
          ...runTruthFields({
            rootMaxConcurrency: props.rootMaxConcurrency,
            limits: props.limits,
            invocationAuthorTurnsAllocated: props.authorTurnBudget,
            invocationAuthorTurnsRemaining: props.authorTurnBudget,
          }),
        },
      },
      children: exhausted,
    });
  }

  const history = [];
  const acceptedRefs = [];
  let generation = 0;
  let previousState;
  let evidence = props.initialEvidence ?? [];
  let dependsOn = props.entryDependsOn ?? [];

  /** @param {Record<string, any>} outcome @param {string[]} taskDeps */
  const settleInvocation = (outcome, taskDeps) =>
    React.createElement(Task, {
      key: invocationOutcomeId,
      id: invocationOutcomeId,
      output: props.outputs.dv2Outcome,
      dependsOn: unique(taskDeps),
      label: `Trellis outcome: ${props.logicalId}`,
      meta: {
        trellis: {
          namespace: "trellis",
          protocolVersion: 2,
          phase: "outcome",
          logicalId: props.logicalId,
          invocationKey: props.invocationKey,
          generation,
          ...runTruthFields({
            rootMaxConcurrency: props.rootMaxConcurrency,
            limits: props.limits,
            invocationAuthorTurnsAllocated: props.authorTurnBudget,
            invocationAuthorTurnsRemaining: remainingAuthorTurns,
          }),
        },
      },
      children: outcome,
    });

  while (generation < props.limits.maxAuthorGenerations && remainingAuthorTurns > 0) {
    const canAuthorSubworkflow = generation < props.limits.maxAuthorGenerations - 1 && remainingAuthorTurns >= 2;
    const authorId = turnNodeId({
      prefix: props.prefix,
      invocationKey: props.invocationKey,
      generation,
      phase: "author",
    });
    const authority = authorityFor({
      role: props.role,
      work: props.work,
      invocationKey: props.invocationKey,
      logicalId: props.logicalId,
      generation,
      parentInvocationKey: props.parentInvocationKey,
      authorDepth: props.authorDepth,
      canAuthorSubworkflow,
      allowAuthorChildren: props.authorDepth + 1 < props.limits.maxAuthorDepth,
      criticalExecutionGrant: props.criticalExecutionGrant,
      criticalExecutionPolicy: props.criticalExecutionPolicy,
      criticalReviewIndependentRoles: props.criticalReviewIndependentRoles,
      hasCappedParallelAncestor: props.hasCappedParallelAncestor,
      limits: props.limits,
      rootMaxConcurrency: props.rootMaxConcurrency,
      authorTurnsRemaining: Math.max(0, remainingAuthorTurns - 1),
    });
    const assignment = {
      instructions: props.instructions ?? null,
      acceptance: props.acceptance,
      criticality: props.criticality ?? null,
    };
    const authorPrompt =
      generation === 0
        ? renderInitialAuthorPrompt({ authority, goal: props.goal, instructions: assignment, evidence })
        : renderContinuationAuthorPrompt({
            authority,
            goal: props.goal,
            instructions: assignment,
            evidence,
            previousState,
            acceptedProgramRefs: acceptedRefs,
          });
    const authorTask = React.createElement(Task, {
      key: authorId,
      id: authorId,
      output: props.outputs.dv2Author,
      outputSchema: authorEnvelopeSchemaFor(props.work),
      maxSchemaRetries: 0,
      agent: requireAgent(props.agents[props.role], props.role),
      dependsOn: unique(dependsOn),
      retries: 0,
      continueOnFail: true,
      label: `${props.role} author: ${props.logicalId} · g${generation}`,
      meta: trellisMeta(authority, authorPrompt, {
        phase: generation === 0 ? "initial" : "continuation",
        invocationKey: props.invocationKey,
        logicalId: props.logicalId,
        authorLineage: lineage,
        generation,
        role: props.role,
        work: props.work,
        ...runTruthFields({
          rootMaxConcurrency: props.rootMaxConcurrency,
          limits: props.limits,
          invocationAuthorTurnsAllocated: props.authorTurnBudget,
          invocationAuthorTurnsRemaining: Math.max(0, remainingAuthorTurns - 1),
        }),
      }),
      children: authorPrompt,
    });
    history.push(authorTask);
    remainingAuthorTurns -= 1;

    const authorRow = delegationV2RowForNode(authorRows, authorId, ctx);
    const baseIdentity = {
      invocationKey: props.invocationKey,
      logicalId: props.logicalId,
      generation,
      sourceNodeId: authorId,
      ...(props.originProgramDigest ? { programDigest: props.originProgramDigest } : {}),
    };
    if (!authorRow) {
      const failure = taskFailureFor(ctx, authorId);
      if (failure)
        history.push(
          settleInvocation(
            settleDelegationV2Envelope({ identity: baseIdentity, assignment: trustedAssignment, taskFailure: failure }),
            [authorId],
          ),
        );
      break;
    }
    if (authorRow.outcome?.tag !== "subworkflow") {
      history.push(
        settleInvocation(
          settleDelegationV2Envelope({ envelope: authorRow, identity: baseIdentity, assignment: trustedAssignment }),
          [authorId],
        ),
      );
      break;
    }

    if (!canAuthorSubworkflow) {
      const validationId = turnNodeId({
        prefix: props.prefix,
        invocationKey: props.invocationKey,
        generation,
        phase: "validate",
      });
      const denied = {
        ok: false,
        status: "rejected",
        programDigest: hashStableValue(authorRow.outcome.value),
        diagnostics: [
          { code: "node_limit", path: "root", message: "No author-generation fuel remains for another subworkflow." },
        ],
        stats: { nodes: 0, agents: 0, authors: 0, maxDepth: 0, maxFanout: 0, totalPromptBytes: 0 },
      };
      history.push(
        React.createElement(Task, {
          key: validationId,
          id: validationId,
          output: props.outputs.dv2Validation,
          dependsOn: [authorId],
          label: `Trellis validation: ${props.logicalId} · fuel denied`,
          children: validationPayload(
            denied,
            { invocationKey: props.invocationKey, generation, authorNodeId: authorId },
            props.criticalExecutionPolicy,
          ),
        }),
      );
      const exhausted = runtimeOutcome(
        baseIdentity,
        trustedAssignment,
        "budget_exhausted",
        "The author returned a subworkflow after author-generation fuel was exhausted.",
      );
      history.push(settleInvocation(exhausted, [validationId]));
      break;
    }

    let acceptedEnvelope = authorRow;
    let acceptedAuthorId = authorId;
    let proposedProgram = authorRow.outcome.value;
    let validationId = turnNodeId({
      prefix: props.prefix,
      invocationKey: props.invocationKey,
      generation,
      phase: "validate",
    });
    let validationResult = enforceDelegationV2AuthorFuel(
      enforceSupersession(
        validateWorkflowProgram(proposedProgram, {
          rootMaxConcurrency: props.rootMaxConcurrency,
          expectedRegistryVersion: DELEGATION_V2_REGISTRY_VERSION,
          criticalExecutionPolicy: props.criticalExecutionPolicy,
          criticalReviewIndependentRoles: props.criticalReviewIndependentRoles,
          allowAuthorChildren: props.authorDepth + 1 < props.limits.maxAuthorDepth,
          hasCappedParallelAncestor: props.hasCappedParallelAncestor,
          limits: {
            maxNodes: props.limits.maxNodesPerProgram,
            maxDepth: props.limits.maxProgramDepth,
            maxFanout: props.limits.maxFanout,
            maxConcurrency: props.rootMaxConcurrency,
            maxPromptBytes: props.limits.maxPromptBytes,
            maxTotalPromptBytes: props.limits.maxTotalPromptBytes,
          },
        }),
        acceptedRefs,
        undefined,
      ),
      remainingAuthorTurns,
    );
    history.push(
      React.createElement(Task, {
        key: validationId,
        id: validationId,
        output: props.outputs.dv2Validation,
        dependsOn: [authorId],
        label: `Trellis validation: ${props.logicalId} · g${generation}`,
        meta: {
          trellis: {
            namespace: "trellis",
            phase: "validation",
            invocationKey: props.invocationKey,
            logicalId: props.logicalId,
            generation,
            authorNodeId: authorId,
          },
        },
        children: validationPayload(
          validationResult,
          { invocationKey: props.invocationKey, generation, authorNodeId: authorId },
          props.criticalExecutionPolicy,
        ),
      }),
    );
    let validationRow = delegationV2RowForNode(validationRows, validationId, ctx);
    if (!validationRow) break;

    if (validationRow.status === "rejected") {
      if (
        validationRow.authorNodeId !== authorId ||
        validationRow.registryVersion !== DELEGATION_V2_REGISTRY_VERSION ||
        validationRow.compilerVersion !== DELEGATION_V2_COMPILER_VERSION ||
        (validationRow.criticalExecutionPolicyHash ?? null) !== (props.criticalExecutionPolicy?.policyHash ?? null) ||
        validationRow.programDigest !== validationResult.programDigest
      ) {
        history.push(
          settleInvocation(
            runtimeOutcome(
              { ...baseIdentity, sourceNodeId: validationId },
              trustedAssignment,
              "invalid_subworkflow",
              "Persisted rejection provenance did not match the captured program.",
            ),
            [validationId],
          ),
        );
        break;
      }
      if (remainingAuthorTurns < 2) {
        const exhausted = runtimeOutcome(
          baseIdentity,
          trustedAssignment,
          "budget_exhausted",
          "Global author-turn fuel cannot fund both semantic repair and the required parent continuation.",
        );
        history.push(settleInvocation(exhausted, [validationId]));
        break;
      }
      const rejectedProgram = proposedProgram;
      const rejectedState = authorRow.state;
      const rejectedDiagnostics = validationResult.diagnostics;
      const rejectedRef = rejectedProgramRef(rejectedProgram, validationRow.programDigest);
      const repairId = turnNodeId({
        prefix: props.prefix,
        invocationKey: props.invocationKey,
        generation,
        phase: "repair",
      });
      const repairAuthority = authorityFor({
        role: props.role,
        work: props.work,
        invocationKey: props.invocationKey,
        logicalId: props.logicalId,
        generation,
        parentInvocationKey: props.parentInvocationKey,
        authorDepth: props.authorDepth,
        canAuthorSubworkflow: true,
        allowAuthorChildren: props.authorDepth + 1 < props.limits.maxAuthorDepth,
        criticalExecutionPolicy: props.criticalExecutionPolicy,
        criticalReviewIndependentRoles: props.criticalReviewIndependentRoles,
        hasCappedParallelAncestor: props.hasCappedParallelAncestor,
        limits: props.limits,
        rootMaxConcurrency: props.rootMaxConcurrency,
        authorTurnsRemaining: Math.max(0, remainingAuthorTurns - 1),
        repair: true,
      });
      const repairPrompt = renderRepairAuthorPrompt({
        authority: repairAuthority,
        goal: props.goal,
        diagnostics: rejectedDiagnostics,
        rejectedProgram,
        requiredSupersedes: rejectedRef,
      });
      history.push(
        React.createElement(Task, {
          key: repairId,
          id: repairId,
          output: props.outputs.dv2Author,
          outputSchema: authorEnvelopeSchemaFor(props.work),
          maxSchemaRetries: 0,
          agent: requireAgent(props.agents[props.role], props.role),
          dependsOn: [validationId],
          retries: 0,
          continueOnFail: true,
          allowTools: [],
          label: `${props.role} semantic repair: ${props.logicalId} · g${generation}`,
          meta: trellisMeta(repairAuthority, repairPrompt, {
            phase: "semantic_repair",
            invocationKey: props.invocationKey,
            logicalId: props.logicalId,
            authorLineage: lineage,
            generation,
            role: props.role,
            work: props.work,
            ...runTruthFields({
              rootMaxConcurrency: props.rootMaxConcurrency,
              limits: props.limits,
              invocationAuthorTurnsAllocated: props.authorTurnBudget,
              invocationAuthorTurnsRemaining: Math.max(0, remainingAuthorTurns - 1),
            }),
          }),
          children: repairPrompt,
        }),
      );
      remainingAuthorTurns -= 1;
      const repairRow = delegationV2RowForNode(authorRows, repairId, ctx);
      const repairIdentity = { ...baseIdentity, sourceNodeId: repairId };
      if (!repairRow) {
        const repairFailure = taskFailureFor(ctx, repairId);
        if (repairFailure) {
          history.push(
            settleInvocation(
              settleDelegationV2Envelope({
                identity: repairIdentity,
                assignment: trustedAssignment,
                taskFailure: repairFailure,
              }),
              [repairId],
            ),
          );
        }
        break;
      }
      if (repairRow.outcome?.tag !== "subworkflow") {
        history.push(
          settleInvocation(
            runtimeOutcome(
              repairIdentity,
              trustedAssignment,
              "invalid_subworkflow",
              "Semantic repair must return a corrected subworkflow.",
            ),
            [repairId],
          ),
        );
        break;
      }

      acceptedEnvelope = repairRow;
      acceptedAuthorId = repairId;
      proposedProgram = repairRow.outcome.value;
      validationId = turnNodeId({
        prefix: props.prefix,
        invocationKey: props.invocationKey,
        generation,
        phase: "repair-validate",
      });
      validationResult = enforceSupersession(
        validateWorkflowProgram(proposedProgram, {
          rootMaxConcurrency: props.rootMaxConcurrency,
          expectedRegistryVersion: DELEGATION_V2_REGISTRY_VERSION,
          criticalExecutionPolicy: props.criticalExecutionPolicy,
          criticalReviewIndependentRoles: props.criticalReviewIndependentRoles,
          allowAuthorChildren: props.authorDepth + 1 < props.limits.maxAuthorDepth,
          hasCappedParallelAncestor: props.hasCappedParallelAncestor,
          limits: {
            maxNodes: props.limits.maxNodesPerProgram,
            maxDepth: props.limits.maxProgramDepth,
            maxFanout: props.limits.maxFanout,
            maxConcurrency: props.rootMaxConcurrency,
            maxPromptBytes: props.limits.maxPromptBytes,
            maxTotalPromptBytes: props.limits.maxTotalPromptBytes,
          },
        }),
        acceptedRefs,
        rejectedRef,
      );
      if (validationResult.ok && validationResult.normalizedProgram) {
        const integrity = validateDelegationV2RepairIntegrity({
          rejectedProgram,
          repairedProgram: proposedProgram,
          diagnostics: rejectedDiagnostics,
          rejectedState,
          repairedState: repairRow.state,
        });
        if (!integrity.ok) {
          validationResult = {
            ...validationResult,
            ok: false,
            status: "rejected",
            normalizedProgram: undefined,
            diagnostics: integrity.diagnostics,
          };
        }
      }
      validationResult = enforceDelegationV2AuthorFuel(validationResult, remainingAuthorTurns);
      history.push(
        React.createElement(Task, {
          key: validationId,
          id: validationId,
          output: props.outputs.dv2Validation,
          dependsOn: [repairId],
          label: `Trellis repair validation: ${props.logicalId} · g${generation}`,
          meta: {
            trellis: {
              namespace: "trellis",
              phase: "validation",
              invocationKey: props.invocationKey,
              logicalId: props.logicalId,
              generation,
              authorNodeId: repairId,
            },
          },
          children: validationPayload(
            validationResult,
            { invocationKey: props.invocationKey, generation, authorNodeId: repairId },
            props.criticalExecutionPolicy,
          ),
        }),
      );
      validationRow = delegationV2RowForNode(validationRows, validationId, ctx);
      if (!validationRow) break;
      if (validationRow.status !== "accepted") {
        history.push(
          settleInvocation(
            runtimeOutcome(
              repairIdentity,
              trustedAssignment,
              "invalid_subworkflow",
              "The one permitted semantic repair was rejected; no descendants were mounted.",
            ),
            [validationId],
          ),
        );
        break;
      }
    }

    if (validationRow.status !== "accepted" || !validationRow.normalizedProgram) {
      history.push(
        settleInvocation(
          runtimeOutcome(
            baseIdentity,
            trustedAssignment,
            "invalid_subworkflow",
            "Accepted validation row was missing normalized IR.",
          ),
          [validationId],
        ),
      );
      break;
    }
    if (
      validationRow.authorNodeId !== acceptedAuthorId ||
      validationRow.registryVersion !== DELEGATION_V2_REGISTRY_VERSION ||
      validationRow.compilerVersion !== DELEGATION_V2_COMPILER_VERSION ||
      (validationRow.criticalExecutionPolicyHash ?? null) !== (props.criticalExecutionPolicy?.policyHash ?? null) ||
      validationRow.programDigest !== delegationV2ProgramDigest(validationRow.normalizedProgram)
    ) {
      history.push(
        settleInvocation(
          runtimeOutcome(
            { ...baseIdentity, sourceNodeId: validationId },
            trustedAssignment,
            "invalid_subworkflow",
            "Persisted validation provenance did not match the accepted program.",
          ),
          [validationId],
        ),
      );
      break;
    }

    const plan = compileDelegationV2Program({
      program: validationRow.normalizedProgram,
      invocationKey: props.invocationKey,
      authorNodeId: acceptedAuthorId,
      generation,
      programDigest: validationRow.programDigest,
      rootMaxConcurrency: props.rootMaxConcurrency,
      criticalExecutionPolicy: props.criticalExecutionPolicy,
      criticalReviewIndependentRoles: props.criticalReviewIndependentRoles,
      allowAuthorChildren: props.authorDepth + 1 < props.limits.maxAuthorDepth,
      hasCappedParallelAncestor: props.hasCappedParallelAncestor,
      validationLimits: {
        maxNodes: props.limits.maxNodesPerProgram,
        maxDepth: props.limits.maxProgramDepth,
        maxFanout: props.limits.maxFanout,
        maxConcurrency: props.rootMaxConcurrency,
        maxPromptBytes: props.limits.maxPromptBytes,
        maxTotalPromptBytes: props.limits.maxTotalPromptBytes,
      },
      prefix: props.prefix,
      authorLineage: lineage,
      entryDependsOn: [validationId],
    });
    const nestedLogicalIds = plan.nodeIndex.filter((node) => node.nestedAuthor === true).map((node) => node.logicalId);
    const remainingLocalGenerations = props.limits.maxAuthorGenerations - generation - 1;
    const fuel = partitionDelegationV2AuthorFuel({
      nestedLogicalIds,
      remainingTurns: remainingAuthorTurns,
      parentCapacity: Math.max(1, remainingLocalGenerations * 2 - 1),
    });
    history.push(
      React.createElement(
        React.Fragment,
        { key: `${plan.programDigest}:fragment` },
        renderCompiledNode(plan.root, {
          ...props,
          ctx,
          outcomeRows: outputRows,
          programDigest: plan.programDigest,
          generation,
          authorLineage: lineage,
          childAuthorBudgets: fuel.childTurns,
        }),
      ),
    );

    const settled = collectDelegationV2Outcomes(outputRows, plan.declaredOutputNodeIds, ctx);
    if (!settled.settled) break;
    const contractMismatch = plan.declaredOutputs.find(
      (declared, index) => settled.rows[index]?.outputContract !== declared.contract,
    );
    if (contractMismatch) {
      const failed = runtimeOutcome(
        { ...baseIdentity, sourceNodeId: contractMismatch.outcomeNodeId, programDigest: plan.programDigest },
        trustedAssignment,
        "invalid_subworkflow",
        `Settled output ${contractMismatch.from} did not preserve declared contract ${contractMismatch.contract}.`,
      );
      history.push(settleInvocation(failed, plan.declaredOutputNodeIds));
      break;
    }
    acceptedRefs.push({ id: plan.programId, digest: plan.programDigest });
    previousState = acceptedEnvelope.state;
    evidence = buildDelegationV2EvidencePacket(settled.rows);
    dependsOn = plan.declaredOutputNodeIds;
    remainingAuthorTurns = fuel.parentTurns;
    generation += 1;
  }

  return React.createElement(Sequence, { label: `Trellis invocation: ${props.logicalId}` }, ...history);
}

/**
 * Render a trusted JSON compiler plan with the fixed Smithers component
 * registry. Model-authored values never become component props outside the
 * validated fields copied explicitly below.
 * @param {Record<string, any>} node
 * @param {Record<string, any>} runtime
 */
function renderCompiledNode(node, runtime) {
  if (node.kind === "sequence") {
    return React.createElement(
      Sequence,
      {
        label: `Trellis sequence: ${node.logicalId}`,
      },
      ...node.steps.map((step) =>
        React.createElement(
          React.Fragment,
          {
            key: step.physicalNodeId,
          },
          renderCompiledNode(step, runtime),
        ),
      ),
    );
  }
  if (node.kind === "parallel") {
    return React.createElement(
      Parallel,
      {
        id: node.physicalNodeId,
        label: `Trellis parallel: ${node.logicalId}`,
        ...(node.maxConcurrency == null ? {} : { maxConcurrency: node.maxConcurrency }),
      },
      ...node.branches.map((branch) =>
        React.createElement(
          React.Fragment,
          {
            key: branch.physicalNodeId,
          },
          renderCompiledNode(branch, runtime),
        ),
      ),
    );
  }
  if (node.kind !== "agent") {
    throw new SmithersError("INVALID_INPUT", `Trellis compiler produced unknown node kind ${String(node.kind)}.`);
  }

  const inputRows = node.inputOutcomeNodeIds
    .map((id) => delegationV2RowForNode(runtime.outcomeRows, id, runtime.ctx))
    .filter(Boolean);
  const boundedEvidence = {
    bindings: node.inputBindings,
    outcomes: buildDelegationV2EvidencePacket(inputRows),
  };
  if (node.nestedAuthor) {
    return React.createElement(TrellisInvocation, {
      key: node.nestedInvocationKey,
      invocationKey: node.nestedInvocationKey,
      parentInvocationKey: node.source.invocationKey,
      logicalId: node.logicalId,
      role: node.role,
      work: node.work,
      outputContract: node.outputContract,
      goal: node.goal,
      instructions: {
        instructions: node.prompt.instructions,
        contextRefs: node.prompt.contextRefs,
        outputContract: node.outputContract,
      },
      acceptance: node.acceptance,
      criticality: node.criticality,
      criticalExecutionGrant: node.criticalExecutionGrant,
      criticalExecutionPolicy: runtime.criticalExecutionPolicy,
      criticalReviewIndependentRoles: runtime.criticalReviewIndependentRoles,
      hasCappedParallelAncestor: node.hasCappedParallelAncestor,
      originProgramDigest: runtime.programDigest,
      initialEvidence: boundedEvidence,
      entryDependsOn: node.dependsOn,
      authorDepth: runtime.authorDepth + 1,
      authorLineage: [...runtime.authorLineage, node.nestedInvocationKey],
      agents: runtime.agents,
      outputs: runtime.outputs,
      prefix: runtime.prefix,
      limits: runtime.limits,
      rootMaxConcurrency: runtime.rootMaxConcurrency,
      authorTurnBudget: runtime.childAuthorBudgets[node.logicalId],
      ctx: runtime.ctx,
    });
  }

  const workerId = node.rawNodeId;
  const workerAuthority = authorityFor({
    role: node.role,
    work: node.work,
    invocationKey: node.source.invocationKey,
    logicalId: node.logicalId,
    generation: runtime.generation,
    parentInvocationKey: node.source.invocationKey,
    authorDepth: runtime.authorDepth,
    canAuthorSubworkflow: false,
    limits: runtime.limits,
    rootMaxConcurrency: runtime.rootMaxConcurrency,
    authorTurnsRemaining: 0,
  });
  const workerPrompt = renderWorkerPrompt({
    authority: workerAuthority,
    goal: node.goal,
    instructions: {
      instructions: node.prompt.instructions,
      contextRefs: node.prompt.contextRefs,
      acceptance: node.acceptance,
      outputContract: node.outputContract,
    },
    evidence: boundedEvidence,
  });
  const workerRow = delegationV2RowForNode(
    readDelegationV2Rows(runtime.ctx, runtime.outputs.dv2Worker),
    workerId,
    runtime.ctx,
  );
  const workerAssignment = {
    role: node.role,
    work: node.work,
    outputContract: node.outputContract,
    goal: node.goal,
    instructions: node.prompt,
    acceptance: node.acceptance,
    criticality: node.criticality,
  };
  const workerFailure = taskFailureFor(runtime.ctx, workerId);
  const outcome =
    workerRow || workerFailure
      ? settleDelegationV2Envelope({
          envelope: workerRow,
          assignment: workerAssignment,
          identity: {
            invocationKey: node.source.invocationKey,
            logicalId: node.logicalId,
            generation: runtime.generation,
            sourceNodeId: workerId,
            programDigest: runtime.programDigest,
          },
          taskFailure: workerFailure,
        })
      : null;
  return React.createElement(
    Sequence,
    { label: `${node.role} ${node.work}: ${node.logicalId}` },
    React.createElement(Task, {
      key: workerId,
      id: workerId,
      output: runtime.outputs.dv2Worker,
      outputSchema: workerEnvelopeSchemaFor(node.work),
      maxSchemaRetries: 0,
      agent: requireAgent(runtime.agents[node.role], node.role),
      dependsOn: node.dependsOn,
      retries: 1,
      continueOnFail: true,
      label: `${node.role} ${node.work}: ${node.logicalId}`,
      meta: trellisMeta(workerAuthority, workerPrompt, {
        phase: "worker",
        invocationKey: node.source.invocationKey,
        logicalId: node.logicalId,
        authorLineage: node.source.authorLineage,
        generation: runtime.generation,
        programId: node.source.programId,
        programDigest: runtime.programDigest,
        containerLineage: node.source.containerLineage,
        role: node.role,
        work: node.work,
      }),
      children: workerPrompt,
    }),
    outcome
      ? React.createElement(Task, {
          key: node.outcomeNodeId,
          id: node.outcomeNodeId,
          output: runtime.outputs.dv2Outcome,
          dependsOn: [workerId],
          label: `Trellis outcome: ${node.logicalId}`,
          meta: {
            trellis: {
              namespace: "trellis",
              protocolVersion: 2,
              phase: "outcome",
              logicalId: node.logicalId,
              invocationKey: node.source.invocationKey,
              generation: runtime.generation,
              programDigest: runtime.programDigest,
            },
          },
          children: outcome,
        })
      : null,
  );
}

/**
 * Dynamic, append-only, model-authored delegation over a closed IR registry.
 * @param {TrellisProps} props
 */
export function Trellis(props) {
  const ctx = React.useContext(SmithersContext);
  if (props.skipIf) return null;
  if (!ctx) {
    throw new SmithersError("CONTEXT_OUTSIDE_WORKFLOW", "Trellis must render inside createSmithers().");
  }
  const prompt = String(props.prompt ?? "").trim();
  if (!prompt) throw new SmithersError("INVALID_INPUT", "Trellis prompt must not be empty.");
  const prefix = props.idPrefix ?? "trellis";
  const rootMaxConcurrency = positiveInteger(props.maxConcurrency ?? 4, "Trellis maxConcurrency");
  assertRuntimePolicy(ctx, rootMaxConcurrency);
  const limits = normalizeLimits(props.limits);
  let criticalExecutionPolicy;
  try {
    criticalExecutionPolicy = normalizeCriticalExecutionPolicy(props.criticalExecutionPolicy);
  } catch (error) {
    throw new SmithersError(
      "INVALID_INPUT",
      `Invalid Trellis criticalExecutionPolicy: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const role = props.role ?? "sol";
  if (!AUTHOR_ROLES.has(role)) {
    throw new SmithersError("INVALID_INPUT", "Trellis root role must be sol or fable.");
  }
  const work = props.work ?? "synthesize";
  const outputContract = outputContractIdSchema.parse(props.outputContract ?? "work_product");
  if (!delegationV2OutputContractAllowed(work, outputContract)) {
    throw new SmithersError("INVALID_INPUT", `Trellis work ${work} cannot return output contract ${outputContract}.`);
  }
  const goal = goalContractSchema.parse(
    props.goal ?? {
      objective: prompt,
      context: [],
      constraints: [],
      nonGoals: [],
    },
  );
  const acceptance = acceptanceCriterionSchema
    .array()
    .min(1)
    .max(32)
    .parse(
      props.acceptance ?? [
        {
          id: "root-goal",
          requirement: "Satisfy the root objective and preserve its stated constraints.",
          verification: "Return criterion-level evidence sufficient to audit the result.",
        },
      ],
    );
  if (new Set(acceptance.map((criterion) => criterion.id)).size !== acceptance.length) {
    throw new SmithersError("INVALID_INPUT", "Trellis root acceptance criterion ids must be unique.");
  }
  for (const agentRole of ["sol", "fable", "terra", "luna"]) {
    requireAgent(props.agents?.[agentRole], agentRole);
  }
  const criticalReviewIndependentRoles = deriveCriticalReviewIndependentRoles(props.agents);
  const instructions = props.instructions ?? prompt;
  const semanticDigest = rootSemanticDigest({
    role,
    work,
    outputContract,
    goal,
    instructions,
    acceptance,
    limits,
    maxConcurrency: rootMaxConcurrency,
    criticalExecutionPolicy,
    criticalReviewIndependentRoles,
    semanticRevision: String(props.semanticRevision ?? "default"),
    agents: props.agents,
  });
  const invocationKey = `${prefix}:root:${semanticDigest.slice(0, 24)}`;
  if (!isGatewaySafeNodeId(invocationKey)) {
    throw new SmithersError("INVALID_INPUT", "Trellis idPrefix must be gateway-safe and short enough.");
  }
  const rootOutcomeId = invocationOutcomeNodeId({ prefix, invocationKey });
  const rootOutcome = delegationV2RowForNode(readDelegationV2Rows(ctx, props.outputs.dv2Outcome), rootOutcomeId, ctx);
  const invocation = React.createElement(TrellisInvocation, {
    key: invocationKey,
    invocationKey,
    logicalId: "root",
    role,
    work,
    outputContract,
    goal,
    instructions,
    acceptance,
    criticalExecutionPolicy,
    criticalReviewIndependentRoles,
    criticalExecutionGrant: null,
    hasCappedParallelAncestor: false,
    initialEvidence: [],
    entryDependsOn: [],
    authorDepth: 0,
    authorLineage: [invocationKey],
    agents: props.agents,
    outputs: props.outputs,
    prefix,
    limits,
    rootMaxConcurrency,
    authorTurnBudget: limits.maxTotalAuthorTurns,
    ctx,
  });
  const final = rootOutcome
    ? React.createElement(Task, {
        key: finalNodeId(prefix, invocationKey),
        id: finalNodeId(prefix, invocationKey),
        output: props.outputs.dv2Final,
        dependsOn: [rootOutcomeId],
        label: "Trellis final",
        meta: {
          trellis: {
            namespace: "trellis",
            protocolVersion: 2,
            phase: "final",
            logicalId: "root",
            invocationKey,
            ...runTruthFields({
              rootMaxConcurrency,
              limits,
              invocationAuthorTurnsAllocated: limits.maxTotalAuthorTurns,
            }),
            ...(criticalExecutionPolicy?.policyHash
              ? { criticalExecutionPolicyHash: criticalExecutionPolicy.policyHash }
              : {}),
          },
        },
        children: finalPayload(rootOutcome),
      })
    : null;
  return React.createElement(Sequence, { label: "Smithers Trellis" }, invocation, final);
}
