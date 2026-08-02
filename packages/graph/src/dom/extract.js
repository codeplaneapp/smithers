// @smithers-type-exports-begin
/** @typedef {import("../HostElement.ts").HostElement} HostElement */
/** @typedef {import("../HostText.ts").HostText} HostText */
// @smithers-type-exports-end

import { resolveStableId } from "../utils/tree-ids.js";
import { getTableName } from "drizzle-orm";
import { DEFAULT_MERGE_QUEUE_CONCURRENCY, MERGE_QUEUE_PRIORITY, WORKTREE_EMPTY_PATH_ERROR } from "../constants.js";
import { SmithersError } from "@smthrs/errors/SmithersError";
import { resolveWorktreePath } from "../worktree-path.js";
import { coerceFiniteNumber } from "../utils/numeric-props.js";
import { normalizeTaskSideEffect } from "../normalizeTaskSideEffect.js";
import { createSubflowResultError } from "../subflow-result-error.js";

/** @typedef {import("../ExtractOptions.ts").ExtractOptions} ExtractOptions */
/** @typedef {import("../ExtractResult.ts").ExtractResult} ExtractResult */
/** @typedef {import("../HostNode.ts").HostNode} HostNode */
/** @typedef {import("../TaskDescriptor.ts").TaskDescriptor} TaskDescriptor */
/** @typedef {import("../XmlNode.ts").XmlNode} XmlNode */

// TODO(migration): Delegate extractFromHost to
// @smthrs/graph.extractGraph once core extraction reaches full
// legacy parity. Current blockers:
// - <Subflow> and <Sandbox> descriptors here attach runtime computeFn handlers
//   that call executeChildWorkflow/executeSandbox; core extractGraph currently
//   emits extraction metadata only.
// - Inline <Subflow> validation and some legacy descriptor-shape details still
//   differ, so replacing this implementation would not produce identical output
//   for all inputs.
let loadRuntimeModule = new Function("specifier", "return import(specifier)");
/**
 * Test-only seam to override the dynamic runtime-module importer used by the
 * <Subflow>/<Sandbox> computeFns. Production behaviour is unchanged — the
 * default native `import()` importer is used unless a test overrides it — so the
 * heavy engine/sandbox packages those computeFns delegate to can be exercised
 * without loading them for real. Returns a restore function.
 * @param {(specifier: string) => Promise<any>} loader
 * @returns {() => void}
 */
export function __setRuntimeModuleLoader(loader) {
  const previous = loadRuntimeModule;
  loadRuntimeModule = loader;
  return () => {
    loadRuntimeModule = previous;
  };
}
// CLI agents (Claude Code, Codex, Cursor, Gemini, Kimi) can spend many minutes reading
// files and thinking without producing stdout. 5 min was still too aggressive:
// reviewer agents on substantive diffs were getting killed mid-review and
// breaking ValidationLoop. 10 min matches the explicit per-task overrides used
// by implement/validate tasks.
//
// The default can be overridden at runtime via the SMITHERS_TASK_HEARTBEAT_MS
// environment variable.
const HEARTBEAT_DEFAULT_MS = 600_000;
function envHeartbeatTimeoutMs() {
  const raw = typeof process !== "undefined" && process?.env ? process.env.SMITHERS_TASK_HEARTBEAT_MS : undefined;
  if (typeof raw !== "string" || raw.length === 0) return HEARTBEAT_DEFAULT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return HEARTBEAT_DEFAULT_MS;
  return Math.floor(parsed);
}
const DEFAULT_LOCAL_TASK_HEARTBEAT_TIMEOUT_MS = envHeartbeatTimeoutMs();
const DEFAULT_SANDBOX_TASK_HEARTBEAT_TIMEOUT_MS = envHeartbeatTimeoutMs();
/**
 * @param {unknown} value
 * @returns {value is any}
 */
function isDrizzleTable(value) {
  if (!value || typeof value !== "object") return false;
  try {
    const name = getTableName(/** @type {any} */ (value));
    return typeof name === "string" && name.length > 0;
  } catch {
    return false;
  }
}
/**
 * @param {unknown} value
 * @returns {value is import("zod").ZodObject<any>}
 */
function isZodObject(value) {
  return Boolean(value && typeof value === "object" && "shape" in value);
}
/**
 * @param {unknown} value
 * @param {"allowedScopes" | "allowedUsers"} field
 * @param {string} nodeId
 * @returns {string[] | undefined}
 */
function approvalRestriction(value, field, nodeId) {
  if (value === undefined) {
    return undefined;
  }
  if (
    !Array.isArray(value) ||
    Array.from(value).some((entry) => typeof entry !== "string" || entry.trim().length === 0)
  ) {
    throw new SmithersError("INVALID_INPUT", `Approval ${nodeId} ${field} must be an array of non-empty strings.`);
  }
  return value;
}
/**
 * @param {Record<string, unknown>} raw
 * @returns {{ proofBindingRequired?: boolean; proofBindings?: import("../ProofBinding.ts").ProofBinding[] }}
 */
function proofBindingProps(raw) {
  if (!Object.hasOwn(raw, "bind")) return {};
  const values = Array.isArray(raw.bind) ? raw.bind : [raw.bind];
  const bindings = values.filter((value) =>
    Boolean(
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof value.table === "string" &&
      typeof value.nodeId === "string" &&
      typeof value.iteration === "number" &&
      Number.isFinite(value.iteration) &&
      typeof value.digest === "string",
    ),
  );
  return {
    proofBindingRequired: true,
    ...(values.length > 0 && bindings.length === values.length ? { proofBindings: bindings } : {}),
  };
}
/**
 * @param {Record<string, unknown>} raw
 * @returns {number | null}
 */
function parseHeartbeatTimeoutMs(raw) {
  const selected = raw.heartbeatTimeoutMs !== undefined ? raw.heartbeatTimeoutMs : raw.heartbeatTimeout;
  const candidate = coerceFiniteNumber(selected);
  if (candidate == null || candidate <= 0) {
    return null;
  }
  return Math.floor(candidate);
}
/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function recordOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}
/**
 * @param {unknown} value
 * @returns {boolean}
 */
function hasObjectChild(value) {
  if (Array.isArray(value)) return value.some(hasObjectChild);
  return value !== null && typeof value === "object";
}
/**
 * @param {HostNode} node
 * @returns {XmlNode}
 */
function toXmlNode(node) {
  if (node.kind === "text") {
    return { kind: "text", text: node.text };
  }
  const element = {
    kind: /** @type {"element"} */ ("element"),
    tag: node.tag,
    props: node.props ?? {},
    children: node.children.map(toXmlNode),
  };
  return element;
}
/**
 * @param {ExtractOptions | undefined} opts
 * @param {string} id
 * @returns {number}
 */
function getRalphIteration(opts, id) {
  const map = opts?.ralphIterations;
  const fallback = typeof opts?.defaultIteration === "number" ? opts.defaultIteration : 0;
  if (!map) return fallback;
  if (map instanceof Map) {
    return map.get(id) ?? fallback;
  }
  const value = /** @type {Record<string, number>} */ (map)[id];
  return typeof value === "number" ? value : fallback;
}
/**
 * @param {Record<string, unknown>} raw
 * @param {boolean} [isAgent]
 * @returns {{ retries: number; retryPolicy: import("../RetryPolicy.ts").RetryPolicy | undefined }}
 */
function resolveRetryConfig(raw, isAgent = false) {
  const noRetry = Boolean(raw.noRetry);
  const continueOnFail = Boolean(raw.continueOnFail);
  const coercedRetries = coerceFiniteNumber(raw.retries);
  const hasExplicitRetries = coercedRetries !== null;
  const hasExplicitRetryPolicy = Boolean(raw.retryPolicy && typeof raw.retryPolicy === "object");
  const defaultNoRetryForContinueOnFail = continueOnFail && !hasExplicitRetries && !hasExplicitRetryPolicy;
  // Agent tasks (CLI agents like Codex/Claude) can hit transient upstream
  // failures (e.g. "thread <uuid> not found"). Give them at least one free
  // retry by default — even when the user opted into continueOnFail —
  // unless they explicitly requested noRetry.
  const retries = noRetry
    ? 0
    : defaultNoRetryForContinueOnFail
      ? isAgent
        ? 1
        : 0
      : hasExplicitRetries
        ? // Clamp negative values to 0 (one attempt, no retries): a
          // negative budget would otherwise yield maxAttempts <= 0 and a
          // task that fails without ever executing.
          Math.max(0, coercedRetries)
        : Infinity;
  const retryPolicy = hasExplicitRetryPolicy
    ? /** @type {import("../RetryPolicy.ts").RetryPolicy} */ (raw.retryPolicy)
    : retries > 0
      ? /** @type {import("../RetryPolicy.ts").RetryPolicy} */ ({ backoff: "exponential", initialDelayMs: 1000 })
      : undefined;
  return { retries, retryPolicy };
}
/**
 * Parse the opt-in `subtreeConcurrency` prop on a parallel element: a cap on
 * how many DIRECT CHILD SUBTREES may be in flight at once (numeric strings
 * coerced, fractional floored; undefined or < 1 disables the cap).
 * @param {Record<string, unknown>} raw
 * @returns {number | undefined}
 */
function parseSubtreeConcurrency(raw) {
  const parsed = Number(raw.subtreeConcurrency);
  if (!Number.isFinite(parsed)) return undefined;
  const max = Math.floor(parsed);
  return max >= 1 ? max : undefined;
}
/**
 * Parse a `priority` prop (numeric strings coerced in line with
 * `maxConcurrency`; non-finite values ignored). Higher-priority runnable
 * tasks claim scarce concurrency slots first; unset means "inherit from the
 * nearest container that set one", ultimately defaulting to 0.
 * @param {unknown} value
 * @returns {number | undefined}
 */
function parsePriority(value) {
  if (value == null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
/** @param {unknown} value @returns {"halt" | "quarantine" | undefined} */
function parseFailurePolicy(value) {
  return value === "halt" || value === "quarantine" ? value : undefined;
}
/**
 * Stable key identifying a direct child of a subtree-capped parallel. Prefers
 * an explicit key/id on the child element so resume stays stable across
 * sibling insertions; falls back to the child's element ordinal.
 * @param {Record<string, unknown>} raw
 * @param {number} ordinal
 * @returns {string}
 */
function resolveSubtreeChildKey(raw, ordinal) {
  if (typeof raw.key === "string" && raw.key.trim().length > 0) {
    return raw.key;
  }
  if (typeof raw.id === "string" && raw.id.trim().length > 0) {
    return raw.id;
  }
  return `child:${ordinal}`;
}
/**
 * @param {HostNode | null} root
 * @param {ExtractOptions} [opts]
 * @returns {ExtractResult}
 */
export function extractFromHost(root, opts) {
  if (!root) {
    return { xml: null, tasks: [], mountedTaskIds: [] };
  }
  /** @type {TaskDescriptor[]} */
  const tasks = [];
  /** @type {string[]} */
  const mountedTaskIds = [];
  const seen = new Set();
  const seenRalph = new Set();
  const seenWorktree = new Set();
  const seenSaga = new Set();
  const seenTcf = new Set();
  let ordinal = 0;
  /**
   * @param {"parallel" | "merge-queue"} tag
   * @param {any} raw
   * @param {number[]} path
   * @param {{ id: string; max?: number }[]} stack
   */
  function pushGroup(tag, raw, path, stack) {
    const id = resolveStableId(raw?.id, tag, path);
    // Coerce numeric strings (e.g. from MDX) in line with scheduler.parseNum
    const n = Number(raw?.maxConcurrency);
    const rawMax = Number.isFinite(n) ? Math.floor(n) : undefined;
    // Concurrency semantics:
    // - merge-queue: default to 1 and always clamp to >= 1
    // - parallel: undefined => unlimited; <= 0 => unlimited; fractional floored
    let max;
    if (tag === "merge-queue") {
      const base = rawMax ?? DEFAULT_MERGE_QUEUE_CONCURRENCY;
      max = Math.max(1, base);
    } else {
      if (rawMax == null) {
        max = undefined;
      } else if (rawMax <= 0) {
        max = undefined; // unbounded for non-positive values
      } else {
        max = rawMax; // positive integer; fractional already floored
      }
    }
    return [...stack, { id, max }];
  }
  /**
   * @param {{ ralphId: string; iteration: number }[]} loopStack
   * @returns {string}
   */
  function buildLoopScope(loopStack) {
    if (loopStack.length === 0) return "";
    return "@@" + loopStack.map((l) => `${l.ralphId}=${l.iteration}`).join(",");
  }
  /**
   * @param {HostNode} node
   * @param {{ path: number[]; iteration: number; ralphId?: string; parentIsRalph: boolean; parallelStack: { id: string; max?: number }[];  worktreeStack: { id: string; path: string; branch?: string; baseBranch?: string }[];  loopStack: { ralphId: string; iteration: number }[]; subtree?: { groupId: string; max: number; childKey: string }; priority?: number; failurePolicy?: "halt" | "quarantine" }} ctx
   */
  function walk(node, ctx) {
    if (node.kind === "text") return;
    let iteration = ctx.iteration;
    const parallelStack = ctx.parallelStack;
    let ralphId = ctx.ralphId;
    const worktreeStack = ctx.worktreeStack;
    let loopStack = ctx.loopStack;
    if (node.tag === "smithers:ralph") {
      if (ctx.parentIsRalph) {
        const innerId = resolveStableId(node.rawProps?.id, "ralph", ctx.path);
        throw new SmithersError(
          "NESTED_LOOP",
          `Nested <Loop>/<Ralph> is not supported: "${innerId}" is nested inside loop "${ctx.ralphId ?? "<outer loop>"}". Run the inner work through a queue such as <MergeQueue> and re-enter via the outer loop's next iteration instead of nesting loops.`,
          { outerLoopId: ctx.ralphId, innerLoopId: innerId },
        );
      }
      const logicalId = resolveStableId(node.rawProps?.id, "ralph", ctx.path);
      // Scope ralph ID by ancestor loop iterations for nested loops
      const scope = buildLoopScope(loopStack);
      const id = logicalId + scope;
      if (seenRalph.has(id)) {
        throw new SmithersError("DUPLICATE_ID", `Duplicate Ralph id detected: ${id}`, { kind: "ralph", id });
      }
      seenRalph.add(id);
      ralphId = id;
      iteration = getRalphIteration(opts, id);
      // Push this loop onto the stack for children
      loopStack = [...loopStack, { ralphId: logicalId, iteration }];
    }
    let nextParallelStack = parallelStack;
    // Priority inheritance: a <Parallel>/<MergeQueue> container's priority
    // becomes the default for every descendant task node (explicit
    // `priority` on a node still wins). <MergeQueue> defaults to
    // MERGE_QUEUE_PRIORITY so landing work outranks starting new work.
    let nextPriority = ctx.priority;
    let nextFailurePolicy = ctx.failurePolicy;
    if (node.tag === "smithers:parallel" || node.tag === "smithers:merge-queue" || node.tag === "smithers:sequence") {
      nextFailurePolicy = parseFailurePolicy(node.rawProps?.failurePolicy) ?? nextFailurePolicy;
    }
    // A parallel may also opt into subtree-level concurrency: every
    // descendant leaf task (not just innermost-group members) records the
    // NEAREST such ancestor so the scheduler can cap in-flight direct
    // children (whole subtrees) instead of leaf tasks.
    let subtreePending;
    if (node.tag === "smithers:parallel") {
      nextParallelStack = pushGroup("parallel", node.rawProps, ctx.path, parallelStack);
      nextPriority = parsePriority(node.rawProps?.priority) ?? nextPriority;
      const subtreeMax = parseSubtreeConcurrency(node.rawProps ?? {});
      if (subtreeMax != null) {
        subtreePending = {
          groupId: nextParallelStack[nextParallelStack.length - 1].id,
          max: subtreeMax,
        };
      }
    }
    // Treat <MergeQueue> as a parallel-concurrency group with default 1
    if (node.tag === "smithers:merge-queue") {
      nextParallelStack = pushGroup("merge-queue", node.rawProps, ctx.path, nextParallelStack);
      nextPriority = parsePriority(node.rawProps?.priority) ?? MERGE_QUEUE_PRIORITY;
    }
    // Entering a Worktree node: push onto the worktree stack
    let nextWorktreeStack = worktreeStack;
    if (node.tag === "smithers:worktree") {
      const id = resolveStableId(node.rawProps?.id, "worktree", ctx.path);
      if (seenWorktree.has(id)) {
        throw new SmithersError("DUPLICATE_ID", `Duplicate Worktree id detected: ${id}`, { kind: "worktree", id });
      }
      seenWorktree.add(id);
      const pathVal = String(node.rawProps?.path ?? "").trim();
      if (!pathVal) {
        throw new SmithersError("WORKTREE_EMPTY_PATH", WORKTREE_EMPTY_PATH_ERROR);
      }
      const normPath = resolveWorktreePath(pathVal, {
        baseRootDir: opts?.baseRootDir,
        workflowPath: opts?.workflowPath,
      });
      const branch = node.rawProps?.branch ? String(node.rawProps.branch) : undefined;
      const baseBranch = node.rawProps?.baseBranch ? String(node.rawProps.baseBranch) : undefined;
      nextWorktreeStack = [...worktreeStack, { id, path: normPath, branch, baseBranch }];
    }
    if (node.tag === "smithers:subflow") {
      const raw = node.rawProps || {};
      const logicalNodeId = raw.id;
      if (!logicalNodeId || typeof logicalNodeId !== "string") {
        throw new SmithersError("TASK_ID_REQUIRED", "Subflow id is required and must be a string.");
      }
      const ancestorScope = loopStack.length > 1 ? buildLoopScope(loopStack.slice(0, -1)) : "";
      const nodeId = logicalNodeId + ancestorScope;
      if (seen.has(nodeId)) {
        throw new SmithersError("DUPLICATE_ID", `Duplicate Subflow id detected: ${nodeId}`, {
          kind: "subflow",
          id: nodeId,
        });
      }
      seen.add(nodeId);
      const outputRaw = raw.output;
      if (!outputRaw) {
        throw new SmithersError("TASK_MISSING_OUTPUT", `Subflow ${nodeId} is missing output.`, { nodeId });
      }
      const outputTable = isDrizzleTable(outputRaw) ? outputRaw : null;
      const outputTableName = outputTable
        ? getTableName(/** @type {any} */ (outputTable))
        : typeof outputRaw === "string"
          ? outputRaw
          : "";
      const outputRef = !outputTable && isZodObject(outputRaw) ? outputRaw : undefined;
      const { retries, retryPolicy } = resolveRetryConfig(raw);
      const timeoutMs = coerceFiniteNumber(raw.timeoutMs);
      const heartbeatTimeoutMs = parseHeartbeatTimeoutMs(raw);
      const continueOnFail = Boolean(raw.continueOnFail);
      const cachePolicy =
        raw.cache && typeof raw.cache === "object"
          ? /** @type {import("../CachePolicy.ts").CachePolicy<unknown>} */ (raw.cache)
          : undefined;
      const dependsOn = Array.isArray(raw.dependsOn) ? raw.dependsOn.filter((v) => typeof v === "string") : undefined;
      const needs =
        raw.needs && typeof raw.needs === "object" && !Array.isArray(raw.needs)
          ? Object.fromEntries(Object.entries(raw.needs).filter(([, v]) => typeof v === "string"))
          : undefined;
      const mode = raw.__smithersSubflowMode ?? raw.mode ?? "childRun";
      if (mode === "inline") {
        // Inline mode is represented structurally by the subtree itself.
        // No standalone task descriptor is created for the subflow node.
        // Children are visited in the generic child traversal below.
      } else {
        const parallelGroup = nextParallelStack[nextParallelStack.length - 1];
        const topWorktree = nextWorktreeStack[nextWorktreeStack.length - 1];
        const descriptor = {
          nodeId,
          ordinal: ordinal++,
          iteration,
          ralphId,
          worktreeId: topWorktree?.id,
          worktreePath: topWorktree?.path,
          worktreeBranch: topWorktree?.branch,
          worktreeBaseBranch: topWorktree?.baseBranch,
          outputTable,
          outputTableName,
          outputRef,
          outputSchema: undefined,
          dependsOn,
          needs,
          needsApproval: false,
          skipIf: Boolean(raw.skipIf),
          retries,
          retryPolicy,
          timeoutMs,
          heartbeatTimeoutMs,
          continueOnFail,
          cachePolicy,
          agent: undefined,
          prompt: undefined,
          staticPayload: undefined,
          computeFn: async () => {
            const { executeChildWorkflow } = await loadRuntimeModule("@smthrs/engine/child-workflow");
            const result = await executeChildWorkflow(undefined, {
              workflow: raw.__smithersSubflowWorkflow,
              input: raw.__smithersSubflowInput,
              rootDir: descriptor.worktreePath ?? opts?.baseRootDir,
              workflowPath: opts?.workflowPath ?? undefined,
            });
            if (result.status !== "finished") {
              throw createSubflowResultError(nodeId, result);
            }
            return result.output;
          },
          label: typeof raw.label === "string" ? raw.label : undefined,
          meta: {
            ...recordOrEmpty(raw.meta),
            __subflow: true,
            __subflowMode: mode,
            __subflowInput: raw.__smithersSubflowInput,
          },
          parallelGroupId: parallelGroup?.id,
          parallelMaxConcurrency: parallelGroup?.max,
          subtreeGroupId: ctx.subtree?.groupId,
          subtreeChildKey: ctx.subtree?.childKey,
          subtreeMax: ctx.subtree?.max,
          priority: parsePriority(raw.priority) ?? ctx.priority,
          failurePolicy: parseFailurePolicy(raw.failurePolicy) ?? ctx.failurePolicy,
        };
        tasks.push(descriptor);
        mountedTaskIds.push(`${nodeId}::${iteration}`);
      }
    }
    if (node.tag === "smithers:sandbox") {
      const raw = node.rawProps || {};
      const logicalNodeId = raw.id;
      if (!logicalNodeId || typeof logicalNodeId !== "string") {
        throw new SmithersError("TASK_ID_REQUIRED", "Sandbox id is required and must be a string.");
      }
      const ancestorScope = loopStack.length > 1 ? buildLoopScope(loopStack.slice(0, -1)) : "";
      const nodeId = logicalNodeId + ancestorScope;
      if (seen.has(nodeId)) {
        throw new SmithersError("DUPLICATE_ID", `Duplicate Sandbox id detected: ${nodeId}`, {
          kind: "sandbox",
          id: nodeId,
        });
      }
      seen.add(nodeId);
      const outputRaw = raw.output;
      if (!outputRaw) {
        throw new SmithersError("TASK_MISSING_OUTPUT", `Sandbox ${nodeId} is missing output.`, { nodeId });
      }
      const outputTable = isDrizzleTable(outputRaw) ? outputRaw : null;
      const outputTableName = outputTable
        ? getTableName(/** @type {any} */ (outputTable))
        : typeof outputRaw === "string"
          ? outputRaw
          : "";
      const outputRef = !outputTable && isZodObject(outputRaw) ? outputRaw : undefined;
      const { retries, retryPolicy } = resolveRetryConfig(raw);
      const timeoutMs = coerceFiniteNumber(raw.timeoutMs);
      const heartbeatTimeoutMs = parseHeartbeatTimeoutMs(raw) ?? DEFAULT_SANDBOX_TASK_HEARTBEAT_TIMEOUT_MS;
      const continueOnFail = Boolean(raw.continueOnFail);
      const cachePolicy =
        raw.cache && typeof raw.cache === "object"
          ? /** @type {import("../CachePolicy.ts").CachePolicy<unknown>} */ (raw.cache)
          : undefined;
      const dependsOn = Array.isArray(raw.dependsOn) ? raw.dependsOn.filter((v) => typeof v === "string") : undefined;
      const needs =
        raw.needs && typeof raw.needs === "object" && !Array.isArray(raw.needs)
          ? Object.fromEntries(Object.entries(raw.needs).filter(([, v]) => typeof v === "string"))
          : undefined;
      const parallelGroup = nextParallelStack[nextParallelStack.length - 1];
      const topWorktree = nextWorktreeStack[nextWorktreeStack.length - 1];
      const runtime = raw.__smithersSandboxRuntime ?? raw.runtime;
      const provider = raw.__smithersSandboxProvider ?? raw.provider;
      const workflowDef = raw.__smithersSandboxWorkflow ?? raw.workflow;
      const descriptor = {
        nodeId,
        ordinal: ordinal++,
        iteration,
        ralphId,
        worktreeId: topWorktree?.id,
        worktreePath: topWorktree?.path,
        worktreeBranch: topWorktree?.branch,
        worktreeBaseBranch: topWorktree?.baseBranch,
        outputTable,
        outputTableName,
        outputRef,
        outputSchema: undefined,
        dependsOn,
        needs,
        needsApproval: false,
        skipIf: Boolean(raw.skipIf),
        retries,
        retryPolicy,
        timeoutMs,
        heartbeatTimeoutMs,
        continueOnFail,
        cachePolicy,
        agent: undefined,
        prompt: undefined,
        staticPayload: undefined,
        computeFn: async () => {
          const [{ executeSandbox }, { executeChildWorkflow }, { applyDiffBundle }] = await Promise.all([
            loadRuntimeModule("@smthrs/sandbox/execute"),
            loadRuntimeModule("@smthrs/engine/child-workflow"),
            loadRuntimeModule("@smthrs/engine/effect/diff-bundle"),
          ]);
          if (!workflowDef) {
            throw new SmithersError("INVALID_INPUT", `Sandbox ${nodeId} is missing workflow definition.`, { nodeId });
          }
          return executeSandbox({
            parentWorkflow: undefined,
            sandboxId: nodeId,
            provider,
            runtime:
              runtime === undefined || runtime === "docker" || runtime === "codeplane" || runtime === "bubblewrap"
                ? runtime
                : (() => {
                    throw new SmithersError("INVALID_INPUT", `Unsupported sandbox runtime: ${String(runtime)}`, {
                      runtime,
                    });
                  })(),
            workflow: workflowDef,
            executeChildWorkflow,
            applyDiffBundle,
            input: raw.__smithersSandboxInput ?? raw.input,
            rootDir: topWorktree?.path ?? process.cwd(),
            allowNetwork: Boolean(raw.allowNetwork),
            maxOutputBytes: 200_000,
            toolTimeoutMs: 60_000,
            reviewDiffs: raw.reviewDiffs,
            autoAcceptDiffs: raw.autoAcceptDiffs,
            allowNested: Boolean(raw.__smithersSandboxAllowNested ?? raw.allowNested),
            config: {
              image: raw.image,
              env: raw.env,
              egress: raw.egress,
              ports: raw.ports,
              volumes: raw.volumes,
              memoryLimit: raw.memoryLimit,
              cpuLimit: raw.cpuLimit,
              command: raw.command,
              workspace: raw.workspace,
            },
          });
        },
        label: typeof raw.label === "string" ? raw.label : undefined,
        meta: {
          ...recordOrEmpty(raw.meta),
          __sandbox: true,
          __sandboxRuntime: runtime,
          __sandboxProvider: provider,
          __sandboxWorkflow: workflowDef,
          __sandboxInput: raw.__smithersSandboxInput ?? raw.input,
          __sandboxAllowNetwork: Boolean(raw.allowNetwork),
          __sandboxReviewDiffs: raw.reviewDiffs,
          __sandboxAutoAcceptDiffs: raw.autoAcceptDiffs,
          __sandboxAllowNested: raw.__smithersSandboxAllowNested ?? raw.allowNested,
          __sandboxConfig: {
            image: raw.image,
            env: raw.env,
            egress: raw.egress,
            ports: raw.ports,
            volumes: raw.volumes,
            memoryLimit: raw.memoryLimit,
            cpuLimit: raw.cpuLimit,
            command: raw.command,
            workspace: raw.workspace,
          },
        },
        parallelGroupId: parallelGroup?.id,
        parallelMaxConcurrency: parallelGroup?.max,
        subtreeGroupId: ctx.subtree?.groupId,
        subtreeChildKey: ctx.subtree?.childKey,
        subtreeMax: ctx.subtree?.max,
        priority: parsePriority(raw.priority) ?? ctx.priority,
        failurePolicy: parseFailurePolicy(raw.failurePolicy) ?? ctx.failurePolicy,
      };
      tasks.push(descriptor);
      mountedTaskIds.push(`${nodeId}::${iteration}`);
      // Isolated subtree: the children execute inside the sandbox child run.
      return;
    }
    if (node.tag === "smithers:wait-for-event") {
      const raw = node.rawProps || {};
      const logicalNodeId = raw.id;
      if (!logicalNodeId || typeof logicalNodeId !== "string") {
        throw new SmithersError("TASK_ID_REQUIRED", "WaitForEvent id is required and must be a string.");
      }
      const ancestorScope = loopStack.length > 1 ? buildLoopScope(loopStack.slice(0, -1)) : "";
      const nodeId = logicalNodeId + ancestorScope;
      if (seen.has(nodeId)) {
        throw new SmithersError("DUPLICATE_ID", `Duplicate WaitForEvent id detected: ${nodeId}`, {
          kind: "wait-for-event",
          id: nodeId,
        });
      }
      seen.add(nodeId);
      const outputRaw = raw.output;
      if (!outputRaw) {
        throw new SmithersError("TASK_MISSING_OUTPUT", `WaitForEvent ${nodeId} is missing output.`, { nodeId });
      }
      const outputTable = isDrizzleTable(outputRaw) ? outputRaw : null;
      const outputTableName = outputTable
        ? getTableName(/** @type {any} */ (outputTable))
        : typeof outputRaw === "string"
          ? outputRaw
          : "";
      const outputRef = !outputTable && isZodObject(outputRaw) ? outputRaw : undefined;
      const outputSchema = isZodObject(raw.outputSchema) ? raw.outputSchema : outputRef;
      const waitAsync = Boolean(raw.waitAsync);
      const timeoutMs = coerceFiniteNumber(raw.timeoutMs);
      const heartbeatTimeoutMs = parseHeartbeatTimeoutMs(raw);
      const dependsOn = Array.isArray(raw.dependsOn) ? raw.dependsOn.filter((v) => typeof v === "string") : undefined;
      const needs =
        raw.needs && typeof raw.needs === "object" && !Array.isArray(raw.needs)
          ? Object.fromEntries(Object.entries(raw.needs).filter(([, v]) => typeof v === "string"))
          : undefined;
      const onTimeout = raw.__smithersOnTimeout ?? raw.onTimeout ?? "fail";
      const parallelGroup = nextParallelStack[nextParallelStack.length - 1];
      const topWorktree = nextWorktreeStack[nextWorktreeStack.length - 1];
      const descriptor = {
        nodeId,
        ordinal: ordinal++,
        iteration,
        ralphId,
        worktreeId: topWorktree?.id,
        worktreePath: topWorktree?.path,
        worktreeBranch: topWorktree?.branch,
        worktreeBaseBranch: topWorktree?.baseBranch,
        outputTable,
        outputTableName,
        outputRef,
        outputSchema,
        dependsOn,
        needs,
        needsApproval: false,
        waitAsync,
        skipIf: Boolean(raw.skipIf),
        retries: 0,
        timeoutMs,
        heartbeatTimeoutMs,
        continueOnFail: onTimeout === "continue" || onTimeout === "skip",
        agent: undefined,
        prompt: undefined,
        staticPayload: undefined,
        computeFn: undefined,
        label: typeof raw.label === "string" ? raw.label : undefined,
        meta: {
          ...recordOrEmpty(raw.meta),
          __waitForEvent: true,
          __eventName: raw.__smithersEventName ?? raw.event,
          __correlationId: raw.__smithersCorrelationId ?? raw.correlationId,
          __onTimeout: onTimeout,
        },
        parallelGroupId: parallelGroup?.id,
        parallelMaxConcurrency: parallelGroup?.max,
        subtreeGroupId: ctx.subtree?.groupId,
        subtreeChildKey: ctx.subtree?.childKey,
        subtreeMax: ctx.subtree?.max,
        priority: parsePriority(raw.priority) ?? ctx.priority,
        failurePolicy: parseFailurePolicy(raw.failurePolicy) ?? ctx.failurePolicy,
      };
      tasks.push(descriptor);
      mountedTaskIds.push(`${nodeId}::${iteration}`);
    }
    if (node.tag === "smithers:timer") {
      const raw = node.rawProps || {};
      const logicalNodeId = raw.id;
      if (!logicalNodeId || typeof logicalNodeId !== "string") {
        throw new SmithersError("TASK_ID_REQUIRED", "Timer id is required and must be a string.");
      }
      if (logicalNodeId.length > 256) {
        throw new SmithersError(
          "INVALID_INPUT",
          `Timer id must be 256 characters or fewer (received ${logicalNodeId.length}).`,
          { nodeId: logicalNodeId, maxLength: 256 },
        );
      }
      const ancestorScope = loopStack.length > 1 ? buildLoopScope(loopStack.slice(0, -1)) : "";
      const nodeId = logicalNodeId + ancestorScope;
      if (seen.has(nodeId)) {
        throw new SmithersError("DUPLICATE_ID", `Duplicate Timer id detected: ${nodeId}`, {
          kind: "timer",
          id: nodeId,
        });
      }
      seen.add(nodeId);
      const duration =
        typeof (raw.__smithersTimerDuration ?? raw.duration) === "string"
          ? String(raw.__smithersTimerDuration ?? raw.duration).trim()
          : "";
      const untilRaw = raw.__smithersTimerUntil ?? raw.until;
      const until =
        typeof untilRaw === "string" ? untilRaw.trim() : untilRaw instanceof Date ? untilRaw.toISOString() : "";
      const hasDuration = duration.length > 0;
      const hasUntil = until.length > 0;
      if ((hasDuration ? 1 : 0) + (hasUntil ? 1 : 0) !== 1) {
        throw new SmithersError("INVALID_INPUT", `Timer ${nodeId} must define exactly one of duration or until.`, {
          nodeId,
          duration: raw.duration,
          until: raw.until,
        });
      }
      if (raw.every !== undefined) {
        throw new SmithersError(
          "INVALID_INPUT",
          `Timer ${nodeId} uses every=, but recurring timers are not supported yet.`,
          { nodeId, every: raw.every },
        );
      }
      const dependsOn = Array.isArray(raw.dependsOn) ? raw.dependsOn.filter((v) => typeof v === "string") : undefined;
      const needs =
        raw.needs && typeof raw.needs === "object" && !Array.isArray(raw.needs)
          ? Object.fromEntries(Object.entries(raw.needs).filter(([, v]) => typeof v === "string"))
          : undefined;
      const parallelGroup = nextParallelStack[nextParallelStack.length - 1];
      const topWorktree = nextWorktreeStack[nextWorktreeStack.length - 1];
      const descriptor = {
        nodeId,
        ordinal: ordinal++,
        iteration,
        ralphId,
        worktreeId: topWorktree?.id,
        worktreePath: topWorktree?.path,
        worktreeBranch: topWorktree?.branch,
        worktreeBaseBranch: topWorktree?.baseBranch,
        outputTable: null,
        outputTableName: "",
        outputRef: undefined,
        outputSchema: undefined,
        dependsOn,
        needs,
        needsApproval: false,
        skipIf: Boolean(raw.skipIf),
        retries: 0,
        timeoutMs: null,
        heartbeatTimeoutMs: null,
        continueOnFail: false,
        cachePolicy: undefined,
        agent: undefined,
        prompt: undefined,
        staticPayload: undefined,
        computeFn: undefined,
        label: typeof raw.label === "string" ? raw.label : `timer:${nodeId}`,
        meta: {
          ...recordOrEmpty(raw.meta),
          __timer: true,
          __timerType: hasDuration ? "duration" : "absolute",
          ...(hasDuration ? { __timerDuration: duration } : {}),
          ...(hasUntil ? { __timerUntil: until } : {}),
        },
        parallelGroupId: parallelGroup?.id,
        parallelMaxConcurrency: parallelGroup?.max,
        subtreeGroupId: ctx.subtree?.groupId,
        subtreeChildKey: ctx.subtree?.childKey,
        subtreeMax: ctx.subtree?.max,
        priority: parsePriority(raw.priority) ?? ctx.priority,
        failurePolicy: parseFailurePolicy(raw.failurePolicy) ?? ctx.failurePolicy,
      };
      tasks.push(descriptor);
      mountedTaskIds.push(`${nodeId}::${iteration}`);
    }
    // Track Saga nodes for duplicate detection
    if (node.tag === "smithers:saga") {
      const id = resolveStableId(node.rawProps?.id, "saga", ctx.path);
      if (seenSaga.has(id)) {
        throw new SmithersError("DUPLICATE_ID", `Duplicate Saga id detected: ${id}`, { kind: "saga", id });
      }
      seenSaga.add(id);
    }
    // Track TryCatchFinally nodes for duplicate detection
    if (node.tag === "smithers:try-catch-finally") {
      const id = resolveStableId(node.rawProps?.id, "tcf", ctx.path);
      if (seenTcf.has(id)) {
        throw new SmithersError("DUPLICATE_ID", `Duplicate TryCatchFinally id detected: ${id}`, {
          kind: "try-catch-finally",
          id,
        });
      }
      seenTcf.add(id);
    }
    if (node.tag === "smithers:task") {
      const raw = node.rawProps || {};
      const logicalNodeId = raw.id;
      if (!logicalNodeId || typeof logicalNodeId !== "string") {
        throw new SmithersError("TASK_ID_REQUIRED", "Task id is required and must be a string.");
      }
      // Scope task nodeId by ancestor loops (all except the innermost, which
      // is already captured by desc.iteration).
      const ancestorScope = loopStack.length > 1 ? buildLoopScope(loopStack.slice(0, -1)) : "";
      const nodeId = logicalNodeId + ancestorScope;
      if (seen.has(nodeId)) {
        throw new SmithersError("DUPLICATE_ID", `Duplicate Task id detected: ${nodeId}`, { kind: "task", id: nodeId });
      }
      seen.add(nodeId);
      const outputRaw = raw.output;
      if (!outputRaw) {
        throw new SmithersError("TASK_MISSING_OUTPUT", `Task ${nodeId} is missing output.`, { nodeId });
      }
      const outputTable = isDrizzleTable(outputRaw) ? outputRaw : null;
      const outputTableName = outputTable
        ? getTableName(/** @type {any} */ (outputTable))
        : typeof outputRaw === "string"
          ? outputRaw
          : "";
      const outputRef = !outputTable && isZodObject(outputRaw) ? outputRaw : undefined;
      const outputSchema = isZodObject(raw.outputSchema) ? raw.outputSchema : outputRef;
      const needsApproval = Boolean(raw.needsApproval);
      const waitAsync = Boolean(raw.waitAsync);
      /** @type {TaskDescriptor["approvalMode"]} */
      const approvalMode =
        raw.approvalMode === "decision" || raw.approvalMode === "select" || raw.approvalMode === "rank"
          ? raw.approvalMode
          : "gate";
      /** @type {TaskDescriptor["approvalOnDeny"]} */
      const approvalOnDeny =
        raw.approvalOnDeny === "continue" || raw.approvalOnDeny === "skip" || raw.approvalOnDeny === "fail"
          ? raw.approvalOnDeny
          : undefined;
      const approvalOptions = Array.isArray(raw.approvalOptions)
        ? raw.approvalOptions
            .filter((value) => Boolean(value && typeof value === "object" && !Array.isArray(value)))
            .map((value) => ({
              key: typeof value.key === "string" ? value.key : "",
              label: typeof value.label === "string" ? value.label : "",
              ...(typeof value.summary === "string" ? { summary: value.summary } : {}),
              ...(value.metadata && typeof value.metadata === "object" && !Array.isArray(value.metadata)
                ? { metadata: value.metadata }
                : {}),
            }))
            .filter((value) => value.key && value.label)
        : undefined;
      const approvalAllowedScopes = approvalRestriction(raw.approvalAllowedScopes, "allowedScopes", logicalNodeId);
      const approvalAllowedUsers = approvalRestriction(raw.approvalAllowedUsers, "allowedUsers", logicalNodeId);
      const approvalAutoApproveRaw =
        raw.approvalAutoApprove &&
        typeof raw.approvalAutoApprove === "object" &&
        !Array.isArray(raw.approvalAutoApprove)
          ? /** @type {Record<string, unknown>} */ (raw.approvalAutoApprove)
          : undefined;
      const approvalAutoApprove = approvalAutoApproveRaw
        ? {
            ...(typeof approvalAutoApproveRaw.after === "number" ? { after: approvalAutoApproveRaw.after } : {}),
            ...(typeof approvalAutoApproveRaw.audit === "boolean" ? { audit: approvalAutoApproveRaw.audit } : {}),
            ...(typeof approvalAutoApproveRaw.conditionMet === "boolean"
              ? { conditionMet: approvalAutoApproveRaw.conditionMet }
              : {}),
            ...(typeof approvalAutoApproveRaw.revertOnMet === "boolean"
              ? { revertOnMet: approvalAutoApproveRaw.revertOnMet }
              : {}),
          }
        : undefined;
      const skipIf = Boolean(raw.skipIf);
      const agent = /** @type {TaskDescriptor["agent"]} */ (raw.agent);
      const kind = raw.__smithersKind;
      if (kind === "human" && raw.retries !== undefined && coerceFiniteNumber(raw.retries) === null) {
        const meta =
          raw.meta && typeof raw.meta === "object" && !Array.isArray(raw.meta)
            ? /** @type {Record<string, unknown>} */ (raw.meta)
            : undefined;
        const maxAttempts = typeof meta?.maxAttempts === "number" ? meta.maxAttempts : raw.retries;
        throw new SmithersError("INVALID_INPUT", `<HumanTask id="${raw.id ?? nodeId}"> maxAttempts must be finite.`, {
          nodeId,
          maxAttempts: String(maxAttempts),
        });
      }
      const isAgent = kind === "agent" || Boolean(agent);
      const { retries, retryPolicy } = resolveRetryConfig(raw, isAgent);
      const timeoutMs = coerceFiniteNumber(raw.timeoutMs);
      const parsedHeartbeatTimeoutMs = parseHeartbeatTimeoutMs(raw);
      const continueOnFail = Boolean(raw.continueOnFail);
      const cachePolicy =
        raw.cache && typeof raw.cache === "object"
          ? /** @type {import("../CachePolicy.ts").CachePolicy<unknown>} */ (raw.cache)
          : undefined;
      const heartbeatTimeoutMs = parsedHeartbeatTimeoutMs ?? (isAgent ? DEFAULT_LOCAL_TASK_HEARTBEAT_TIMEOUT_MS : null);
      if (isAgent && hasObjectChild(raw.children)) {
        throw new SmithersError(
          "MDX_PRELOAD_INACTIVE",
          `Task "${raw.id ?? nodeId}" prompt resolved to [object Object] — MDX preload is likely not active.\n` +
            `Check that bunfig.toml has a top-level preload (not under [run]) and mdxPlugin() is registered.`,
        );
      }
      const prompt = isAgent ? String(raw.children ?? "") : undefined;
      const isCompute = (kind === "compute" || kind === "human") && typeof raw.__smithersComputeFn === "function";
      const taskKind = kind === "human" && isCompute ? "human" : isAgent ? "agent" : isCompute ? "compute" : "static";
      const computeFn = isCompute ? /** @type {() => unknown} */ (raw.__smithersComputeFn) : undefined;
      const staticPayload = isAgent || isCompute ? undefined : (raw.__smithersPayload ?? raw.__payload ?? raw.children);
      const dependsOn = Array.isArray(raw.dependsOn)
        ? raw.dependsOn.filter((value) => typeof value === "string")
        : undefined;
      const needs =
        raw.needs && typeof raw.needs === "object" && !Array.isArray(raw.needs)
          ? Object.fromEntries(Object.entries(raw.needs).filter(([, value]) => typeof value === "string"))
          : undefined;
      const parallelGroup = nextParallelStack[nextParallelStack.length - 1];
      const topWorktree = nextWorktreeStack[nextWorktreeStack.length - 1];
      const descriptor = {
        nodeId,
        ordinal: ordinal++,
        iteration,
        kind: /** @type {TaskDescriptor["kind"]} */ (taskKind),
        sideEffect: normalizeTaskSideEffect(raw.sideEffect),
        ...proofBindingProps(raw),
        ralphId,
        worktreeId: topWorktree?.id,
        worktreePath: topWorktree?.path,
        worktreeBranch: topWorktree?.branch,
        worktreeBaseBranch: topWorktree?.baseBranch,
        outputTable,
        outputTableName,
        outputRef,
        outputSchema,
        dependsOn,
        needs,
        needsApproval,
        waitAsync,
        approvalMode,
        approvalOnDeny,
        approvalOptions,
        approvalAllowedScopes,
        approvalAllowedUsers,
        approvalAutoApprove,
        skipIf,
        retries,
        maxSchemaRetries: typeof raw.maxSchemaRetries === "number" ? raw.maxSchemaRetries : undefined,
        retryPolicy,
        timeoutMs,
        heartbeatTimeoutMs,
        continueOnFail,
        cachePolicy,
        hijack: Boolean(raw.hijack),
        onHijackExit: /** @type {"reopen" | "complete"} */ (raw.onHijackExit === "reopen" ? "reopen" : "complete"),
        agent,
        prompt,
        staticPayload,
        computeFn,
        label: typeof raw.label === "string" ? raw.label : undefined,
        meta:
          raw.meta && typeof raw.meta === "object" && !Array.isArray(raw.meta)
            ? /** @type {Record<string, unknown>} */ (raw.meta)
            : undefined,
        scorers:
          raw.scorers && typeof raw.scorers === "object" && !Array.isArray(raw.scorers)
            ? /** @type {import("../ScorersMap.ts").ScorersMap} */ (raw.scorers)
            : undefined,
        parallelGroupId: parallelGroup?.id,
        parallelMaxConcurrency: parallelGroup?.max,
        subtreeGroupId: ctx.subtree?.groupId,
        subtreeChildKey: ctx.subtree?.childKey,
        subtreeMax: ctx.subtree?.max,
        priority: parsePriority(raw.priority) ?? ctx.priority,
        failurePolicy: parseFailurePolicy(raw.failurePolicy) ?? ctx.failurePolicy,
        memoryConfig:
          raw.memory && typeof raw.memory === "object" && !Array.isArray(raw.memory)
            ? /** @type {TaskDescriptor["memoryConfig"]} */ (raw.memory)
            : undefined,
      };
      // Worktree path is captured in typed fields (worktreeId/worktreePath) and
      // consumed by the engine; avoid attaching untyped ad-hoc properties.
      tasks.push(descriptor);
      mountedTaskIds.push(`${nodeId}::${iteration}`);
    }
    let elementIndex = 0;
    for (const child of node.children) {
      const childOrdinal = elementIndex;
      const nextPath = child.kind === "element" ? [...ctx.path, elementIndex++] : ctx.path;
      walk(child, {
        path: nextPath,
        iteration,
        ralphId,
        parentIsRalph: node.tag === "smithers:ralph",
        parallelStack: nextParallelStack,
        worktreeStack: nextWorktreeStack,
        loopStack,
        subtree:
          subtreePending && child.kind === "element"
            ? {
                groupId: subtreePending.groupId,
                max: subtreePending.max,
                childKey: resolveSubtreeChildKey(child.rawProps ?? {}, childOrdinal),
              }
            : ctx.subtree,
        priority: nextPriority,
        failurePolicy: nextFailurePolicy,
      });
    }
  }
  walk(root, { path: [], iteration: 0, parentIsRalph: false, parallelStack: [], worktreeStack: [], loopStack: [] });
  return { xml: toXmlNode(root), tasks, mountedTaskIds };
}
