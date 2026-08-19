import * as Digest from "@flows/core/Digest";
import * as KeyMaterial from "@flows/plan/KeyMaterial";
import * as Node from "@flows/plan/Node";
import * as Plan from "@flows/plan/Plan";
import * as Flow from "@flows/flow/Flow";
import type { GraphSnapshot, TaskDescriptor } from "@smthrs/graph/types";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import { actionFor, type TaskKind, type Tier } from "./actions.ts";
import { makeNodeIndex, SmithersNodes, SmithersOrigin } from "./annotations.ts";
import { agentStepFor } from "./internal/agentStep.ts";
import { functionDigest, jsonSafe } from "./internal/jsonSafe.ts";
import {
  CompileError,
  type CompileDiagnostic,
  type CompiledFlow,
  type CompiledNode,
  type CompiledWorkflow,
  type CompileOptions,
} from "./types.ts";

/**
 * A plan node's structural address.
 *
 * Derived from the task's position in the frame and from nothing else, because
 * `@smthrs/plan` treats a node id as a lookup address that never enters the
 * hashed value. `extractGraph` hands out one ordinal per task per frame, and a
 * loop iteration already carries its own `nodeId`, so the ordinal alone is
 * unique within a snapshot.
 */
const planNodeIdOf = (task: TaskDescriptor): string => `root.task.${task.ordinal}`;

/**
 * The flows tier a `<Task sideEffect>` declaration implies.
 *
 * No declaration means the task claims no external effect, which is `sealed`.
 * A declared `revert` is an undo, which is exactly what `compensable` means. A
 * declared effect with no undo is `irreversible` whether or not the author
 * called it idempotent: idempotence makes a retry safe, it does not make the
 * effect reversible, and the two are separate facts in flows.
 */
export const tierOf = (task: TaskDescriptor): Tier => {
  if (task.kind === "static") return "sealed";
  const sideEffect = task.sideEffect;
  if (sideEffect === undefined) return "sealed";
  return sideEffect.revert === undefined ? "irreversible" : "compensable";
};

const kindOf = (task: TaskDescriptor): TaskKind => task.kind ?? "static";

/**
 * Capability names derived from what the task declares.
 *
 * These ride the key material, so a task that gains an approval gate or a
 * worktree re-keys. Nothing here is configuration: every entry is read off the
 * descriptor.
 */
const capabilitiesOf = (task: TaskDescriptor): readonly string[] => {
  const out = new Set<string>([`task:${kindOf(task)}`]);
  if (task.needsApproval) out.add("approval");
  if (task.worktreeId !== undefined) out.add("worktree");
  if (task.hijack) out.add("hijack");
  if (task.memoryConfig !== undefined) out.add("memory");
  if (task.repair !== undefined) out.add("repair");
  if (task.proofBindingRequired) out.add("proof-binding");
  if (task.forkSource !== undefined) out.add("fork");
  return [...out].sort();
};

/**
 * The output shape a task declares, reduced to something canonical JSON holds.
 *
 * A zod schema is a live object graph with functions in it, so only its
 * top-level field names travel. That is enough for an added or removed output
 * column to re-key the step; a change confined to one field's validator is not
 * visible here, and the descriptor offers nothing more that is serializable.
 */
const outputShape = (task: TaskDescriptor): readonly string[] | undefined => {
  const schema = task.outputSchema ?? task.outputRef;
  if (schema === undefined) return undefined;
  const shape = (schema as { shape?: Record<string, unknown> }).shape;
  if (shape === undefined || typeof shape !== "object") return undefined;
  return Object.keys(shape).sort();
};

/**
 * The declaration half of a task's identity: everything that changes what the
 * task does but is not part of the action payload.
 *
 * Pure scheduling knobs are deliberately absent — `parallelGroupId`,
 * `parallelMaxConcurrency`, the `subtree*` group caps, `priority`, and
 * `failurePolicy`. `@smthrs/plan` keeps ordering edges out of a key for the
 * reason that applies to all of them: a task run in a different concurrency
 * group still computes the same result, so re-keying it would throw away a
 * legitimate cache hit. `priority` reaches the plan as `NodeDraft.priority`,
 * which the plan digest covers and the step key does not.
 */
const declarationOf = (task: TaskDescriptor): Record<string, unknown> => {
  const declaration: Record<string, unknown> = {
    approvalMode: task.approvalMode,
    approvalOnDeny: task.approvalOnDeny,
    approvalOptions: task.approvalOptions,
    approvalAllowedScopes: task.approvalAllowedScopes,
    approvalAllowedUsers: task.approvalAllowedUsers,
    approvalAutoApprove: task.approvalAutoApprove,
    aspects: task.aspects,
    cachePolicy: task.cachePolicy,
    context: task.context,
    continueOnFail: task.continueOnFail,
    groundTruth: task.groundTruth,
    heartbeatTimeoutMs: task.heartbeatTimeoutMs,
    hijack: task.hijack,
    // A loop body re-renders once per iteration with the same node id.
    // The iteration is what makes the two executions different work, so
    // it is content: without it iteration 2 would cache-hit iteration 1.
    iteration: task.iteration,
    maxSchemaRetries: task.maxSchemaRetries,
    memoryConfig: task.memoryConfig,
    meta: task.meta,
    needsApproval: task.needsApproval,
    onHijackExit: task.onHijackExit,
    outputSchema: outputShape(task),
    outputTableName: task.outputTableName,
    proofBindingRequired: task.proofBindingRequired,
    ralphId: task.ralphId,
    repair:
      task.repair === undefined ? undefined : { retries: task.repair.retries, instructions: task.repair.instructions },
    retries: task.retries,
    retryPolicy: task.retryPolicy,
    scorers: task.scorers === undefined ? undefined : Object.keys(task.scorers).sort(),
    sideEffect:
      task.sideEffect === undefined
        ? undefined
        : { idempotent: task.sideEffect.idempotent, reversible: task.sideEffect.revert !== undefined },
    skipIf: task.skipIf,
    timeoutMs: task.timeoutMs,
    waitAsync: task.waitAsync,
    worktreeBaseBranch: task.worktreeBaseBranch,
    worktreeBranch: task.worktreeBranch,
    worktreeId: task.worktreeId,
  };
  for (const key of Object.keys(declaration)) {
    if (declaration[key] === undefined) delete declaration[key];
  }
  return jsonSafe(declaration) as Record<string, unknown>;
};

/** The payload the compiled action is dispatched with. */
const payloadOf = (task: TaskDescriptor, input: Record<string, unknown>): Record<string, unknown> => {
  switch (kindOf(task)) {
    case "agent":
      return { nodeId: task.nodeId, step: agentStepFor(task, input) };
    case "compute":
    case "human":
      return {
        nodeId: task.nodeId,
        source: task.computeFn === undefined ? "" : functionDigest(task.computeFn),
      };
    default:
      return { nodeId: task.nodeId, value: jsonSafe(task.staticPayload) };
  }
};

type Declared = {
  readonly name: string;
  readonly payloadSchema: Schema.Top;
  readonly call: (payload: unknown) => Node.Any;
};

const declared = (kind: TaskKind, tier: Tier): Declared => actionFor(kind, tier) as unknown as Declared;

const encodePayload = (declaration: Declared, payload: unknown): unknown => {
  // The declaration's payload schema is only known at runtime here, so the JSON
  // codec it produces cannot be named statically.
  const codec = Schema.toCodecJson(declaration.payloadSchema) as never;
  return Schema.encodeUnknownSync(codec)(payload);
};

/**
 * The hashed form of a dispatch payload.
 *
 * `nodeId` is stripped for agent and static steps: it is a lookup address, and
 * hashing it would make renaming a task throw away a legitimate cache hit.
 *
 * It is KEPT for compute and human steps, and that asymmetry is deliberate. A
 * `computeFn` is a closure, and JavaScript cannot inspect what a closure
 * captured, so its source digest alone does not identify what it will compute.
 * Pinning those steps to their node id is the conservative reading: it costs a
 * cache hit on a rename and prevents a wrong one on a capture.
 */
const hashedPayload = (kind: TaskKind, encoded: unknown): unknown => {
  if (kind === "compute" || kind === "human") return encoded;
  const { nodeId: _nodeId, ...rest } = encoded as Record<string, unknown>;
  return rest;
};

/** Every plan node declares no filesystem boundary: Smithers tasks do not declare one. */
const NO_EFFECTS: Plan.NodeEffects = { reads: [], writes: [], boundaryMode: "expected" };

type Edges = {
  /** Plan node ids whose result this task consumes. */
  readonly consumes: readonly string[];
  /** Plan node ids this task is only ordered behind. */
  readonly after: readonly string[];
};

/**
 * Turns a task's declared dependencies into plan edges.
 *
 * `needs` (which `<Task deps>` resolves into) is a VALUE dependency: the task
 * reads the upstream row, so it becomes a `Ref`. `dependsOn` and `forkSource`
 * say only "not before", so they become `Pending`. Both fold the upstream's
 * computed key into this task's key — that is how content addressing
 * invalidates a subgraph — but they are hashed under different reference tags,
 * so a pair joined by an ordering constraint never collides with the same pair
 * joined by a value one. `@smthrs/plan` derives the edge set from exactly these
 * references, so an edge and a hashed reference can never disagree.
 */
const edgesOf = (
  task: TaskDescriptor,
  planNodeIdByNodeId: ReadonlyMap<string, string>,
  diagnostics: CompileDiagnostic[],
): { readonly inputs: readonly KeyMaterial.InputRef[]; readonly edges: Edges } => {
  const inputs: KeyMaterial.InputRef[] = [];
  const consumes: string[] = [];
  const after: string[] = [];
  const resolve = (nodeId: string, source: string): string | undefined => {
    const planNodeId = planNodeIdByNodeId.get(nodeId);
    if (planNodeId === undefined) {
      diagnostics.push({
        code: "unknown_dependency",
        nodeId: task.nodeId,
        message: `${source} names ${nodeId}, which is not in this frame`,
      });
      return undefined;
    }
    return planNodeId;
  };
  for (const key of Object.keys(task.needs ?? {}).sort()) {
    const target = resolve(task.needs![key]!, `needs.${key}`);
    if (target === undefined || consumes.includes(target)) continue;
    consumes.push(target);
    inputs.push({ _tag: "Ref", from: target, path: [] });
  }
  const ordering = [
    ...(task.dependsOn ?? []).map((nodeId) => [nodeId, "dependsOn"] as const),
    ...(task.forkSource === undefined ? [] : [[task.forkSource, "forkSource"] as const]),
  ];
  for (const [nodeId, source] of ordering) {
    const target = resolve(nodeId, source);
    if (target === undefined || consumes.includes(target) || after.includes(target)) continue;
    after.push(target);
    inputs.push({ _tag: "Pending", from: target });
  }
  return { inputs, edges: { consumes, after } };
};

/**
 * Dependency waves, in plan order.
 *
 * The flow body is the plan's topology written as flows combinators: each wave
 * is a `Node.all` of steps with no edge between them, and the waves are
 * sequenced with `Node.andThen`. Concurrency inside a wave is what the plan
 * already says; the sequencing between waves is what its edges already say.
 */
const wavesOf = (order: readonly string[], edges: ReadonlyMap<string, Edges>): readonly (readonly string[])[] => {
  const remaining = new Set(order);
  const settled = new Set<string>();
  const waves: string[][] = [];
  while (remaining.size > 0) {
    const wave = [...remaining].filter((id) => {
      const edge = edges.get(id)!;
      return [...edge.consumes, ...edge.after].every((target) => settled.has(target) || !remaining.has(target));
    });
    /* v8 ignore next -- Plan.compile rejects a cycle before this runs */
    if (wave.length === 0) throw new CompileError("cycle", "Compiled plan contains a dependency cycle");
    for (const id of wave) remaining.delete(id);
    for (const id of wave) settled.add(id);
    waves.push(wave);
  }
  return waves;
};

const runPlan = (planId: string, flowName: string, drafts: readonly Plan.NodeDraft[]): Plan.Plan => {
  try {
    return Digest.runSync(Plan.compile({ planId, flow: flowName, nodes: drafts }));
  } catch (cause) {
    const code = (cause as { code?: string; _tag?: string })?.code ?? "plan_failed";
    throw new CompileError(code, `Plan compilation failed: ${String((cause as Error)?.message ?? cause)}`, {
      cause,
    });
  }
};

/**
 * Compiles a `GraphSnapshot` into a flows plan, the action declarations its
 * steps dispatch through, and the flow definition whose body is that graph.
 *
 * The compilation is pure: it hashes, and does nothing else. No filesystem, no
 * clock, no network, which is the plan-phase law `@smthrs/plan` is written
 * against.
 */
export const compileGraphSnapshot = (snapshot: GraphSnapshot, options: CompileOptions = {}): CompiledWorkflow => {
  const planId = options.planId ?? snapshot.runId;
  const flowName = options.flowName ?? "smithers/workflow";
  if (planId === "") throw new CompileError("invalid_plan_id", "A plan id is required");

  const tasks = [...snapshot.tasks].sort((left, right) => left.ordinal - right.ordinal);
  const planNodeIdByNodeId = new Map(tasks.map((task) => [task.nodeId, planNodeIdOf(task)]));
  const diagnostics: CompileDiagnostic[] = [];

  const drafts: Plan.NodeDraft[] = [];
  const edges = new Map<string, Edges>();
  const calls = new Map<string, Node.Any>();
  const descriptors = new Map<string, TaskDescriptor>();
  const computeFns = new Map<string, () => unknown | Promise<unknown>>();
  const kinds = new Map<string, { kind: TaskKind; tier: Tier; action: string }>();

  for (const task of tasks) {
    const planNodeId = planNodeIdOf(task);
    const kind = kindOf(task);
    const tier = tierOf(task);
    const declaration = declared(kind, tier);
    const { inputs, edges: taskEdges } = edgesOf(task, planNodeIdByNodeId, diagnostics);

    const input: Record<string, unknown> = {};
    for (const key of Object.keys(task.needs ?? {}).sort()) input[key] = task.needs![key];
    const payload = payloadOf(task, input);
    const encoded = encodePayload(declaration, payload);

    const material: KeyMaterial.KeyMaterial = {
      version: KeyMaterial.version,
      // Always `sealed`: a content key is only defined for sealed material.
      // The task's real durability tier is the ACTION's tier, and it rides the
      // hashed body below so a task that gains a side effect still re-keys.
      kind: "sealed",
      ...(kind === "agent" ? { nondeterministic: true as const } : {}),
      body: {
        action: declaration.name,
        kind,
        tier,
        payload: hashedPayload(kind, encoded),
        declaration: declarationOf(task),
      },
      inputs,
      layers: [],
      capabilities: capabilitiesOf(task),
      effects: NO_EFFECTS,
    };

    drafts.push({
      id: planNodeId,
      kind: kind === "agent" ? "agent" : "step",
      material,
      effects: NO_EFFECTS,
      priority: Math.trunc(task.priority ?? 0),
    });
    edges.set(planNodeId, taskEdges);
    calls.set(planNodeId, declaration.call(payload));
    descriptors.set(planNodeId, task);
    kinds.set(planNodeId, { kind, tier, action: declaration.name });
    if (task.computeFn !== undefined) computeFns.set(task.nodeId, task.computeFn);
  }

  const plan = runPlan(planId, flowName, drafts);
  const keyByPlanNodeId = new Map(plan.nodes.map((node) => [node.id, node.key]));

  const nodes: CompiledNode[] = tasks.map((task) => {
    const planNodeId = planNodeIdOf(task);
    const identity = kinds.get(planNodeId)!;
    const taskEdges = edges.get(planNodeId)!;
    return {
      planNodeId,
      nodeId: task.nodeId,
      key: keyByPlanNodeId.get(planNodeId)!,
      kind: identity.kind,
      tier: identity.tier,
      action: identity.action,
      ordinal: task.ordinal,
      iteration: task.iteration,
      ...(task.label === undefined ? {} : { label: task.label }),
      consumes: taskEdges.consumes,
      after: taskEdges.after,
    };
  });

  const index = makeNodeIndex(nodes);
  const waves = wavesOf(tasks.map(planNodeIdOf), edges);
  const body = (): Node.Any => {
    if (waves.length === 0) return Node.succeed({});
    const level = (ids: readonly string[]): Node.Any =>
      Node.all(Object.fromEntries(ids.map((id) => [id, calls.get(id)!])));
    let composed = level(waves[0]!);
    for (const wave of waves.slice(1)) composed = Node.andThen(composed, level(wave));
    return composed;
  };

  const flow = Flow.make(flowName, {
    payload: { runId: Schema.String, input: Schema.Unknown },
    success: Schema.Unknown,
    annotations: Context.empty().pipe(
      Context.add(SmithersNodes, index),
      Context.add(SmithersOrigin, { runId: snapshot.runId, frameNo: snapshot.frameNo }),
    ),
    // The body is assembled from the snapshot, so its success and error types
    // are only known at runtime.
    body: body as never,
  }) as unknown as CompiledFlow;

  return { plan, flow, nodes, computeFns, tasks: descriptors, diagnostics };
};
