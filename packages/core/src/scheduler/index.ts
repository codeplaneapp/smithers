import { Context, Effect, Layer } from "effect";
import { SmithersError } from "../errors/index.ts";
import type { TaskDescriptor, XmlNode } from "../graph/types.ts";
import { buildStateKey, type TaskState, type TaskStateMap } from "../state/index.ts";
import { MetricsService } from "../observability/metrics.ts";
import { TracingService } from "../observability/tracing.ts";

export type { TaskState, TaskStateMap } from "../state/index.ts";

export type PlanNode =
  | { readonly kind: "task"; readonly nodeId: string }
  | { readonly kind: "sequence"; readonly children: readonly PlanNode[] }
  | { readonly kind: "parallel"; readonly children: readonly PlanNode[] }
  | {
      readonly kind: "ralph";
      readonly id: string;
      readonly children: readonly PlanNode[];
      readonly until: boolean;
      readonly maxIterations: number;
      readonly onMaxReached: "fail" | "return-last";
      readonly continueAsNewEvery?: number;
    }
  | {
      readonly kind: "continue-as-new";
      readonly stateJson?: string;
    }
  | { readonly kind: "group"; readonly children: readonly PlanNode[] }
  | {
      readonly kind: "saga";
      readonly id: string;
      readonly actionChildren: readonly PlanNode[];
      readonly compensationChildren: readonly PlanNode[];
      readonly onFailure: "compensate" | "compensate-and-fail" | "fail";
    }
  | {
      readonly kind: "try-catch-finally";
      readonly id: string;
      readonly tryChildren: readonly PlanNode[];
      readonly catchChildren: readonly PlanNode[];
      readonly finallyChildren: readonly PlanNode[];
    };

export type ScheduleResult = {
  readonly runnable: readonly TaskDescriptor[];
  readonly pendingExists: boolean;
  readonly waitingApprovalExists: boolean;
  readonly waitingEventExists: boolean;
  readonly waitingTimerExists: boolean;
  readonly readyRalphs: readonly RalphMeta[];
  readonly continuation?: ContinuationRequest;
  readonly nextRetryAtMs?: number;
  readonly fatalError?: string;
};

export type RalphMeta = {
  readonly id: string;
  readonly until: boolean;
  readonly maxIterations: number;
  readonly onMaxReached: "fail" | "return-last";
  readonly continueAsNewEvery?: number;
};

export type ContinuationRequest = {
  readonly stateJson?: string;
};

export type RalphState = {
  readonly iteration: number;
  readonly done: boolean;
};

export type RalphStateMap = Map<string, RalphState>;
export type RetryWaitMap = Map<string, number>;

export type ScheduleSnapshot = {
  readonly plan: PlanNode | null;
  readonly result: ScheduleResult;
  readonly computedAtMs: number;
};

export class Scheduler extends Context.Tag("Scheduler")<
  Scheduler,
  {
    readonly schedule: (
      plan: PlanNode | null,
      states: TaskStateMap,
      descriptors: Map<string, TaskDescriptor>,
      ralphState: RalphStateMap,
      retryWait: RetryWaitMap,
      nowMs: number,
    ) => Effect.Effect<ScheduleResult>;
  }
>() {}

function stablePathId(prefix: string, path: readonly number[]): string {
  if (path.length === 0) return `${prefix}:root`;
  return `${prefix}:${path.join(".")}`;
}

function resolveStableId(
  explicitId: unknown,
  prefix: string,
  path: readonly number[],
): string {
  if (typeof explicitId === "string" && explicitId.trim().length > 0) {
    return explicitId;
  }
  return stablePathId(prefix, path);
}

function parseBool(value: string | undefined): boolean {
  if (!value) return false;
  return value === "true" || value === "1";
}

function parseNum(value: string | undefined, fallback: number): number {
  const parsed = value ? Number(value) : NaN;
  return !Number.isNaN(parsed) ? parsed : fallback;
}

function buildLoopScope(
  loopStack: readonly { readonly ralphId: string; readonly iteration: number }[],
): string {
  if (loopStack.length === 0) return "";
  return `@@${loopStack.map((entry) => `${entry.ralphId}=${entry.iteration}`).join(",")}`;
}

export function buildPlanTree(
  xml: XmlNode | null,
  ralphState?: RalphStateMap,
): {
  readonly plan: PlanNode | null;
  readonly ralphs: readonly RalphMeta[];
} {
  if (!xml) return { plan: null, ralphs: [] };
  const ralphs: RalphMeta[] = [];
  const seenRalph = new Set<string>();

  function walk(
    node: XmlNode,
    ctx: {
      readonly path: readonly number[];
      readonly parentIsRalph: boolean;
      readonly loopStack: readonly { readonly ralphId: string; readonly iteration: number }[];
    },
  ): PlanNode | null {
    if (node.kind === "text") return null;
    const tag = node.tag;

    if (ctx.parentIsRalph && tag === "smithers:ralph") {
      throw new SmithersError("NESTED_LOOP", "Nested <Ralph> is not supported.");
    }

    let loopStack = ctx.loopStack;
    let scopedRalphId: string | undefined;

    if (tag === "smithers:ralph") {
      const logicalId = resolveStableId(node.props.id, "ralph", ctx.path);
      const scope = buildLoopScope(loopStack);
      scopedRalphId = logicalId + scope;
      const currentIter = ralphState?.get(scopedRalphId)?.iteration ?? 0;
      loopStack = [...loopStack, { ralphId: logicalId, iteration: currentIter }];
    }

    if (tag === "smithers:saga") {
      const id = resolveStableId(node.props.id, "saga", ctx.path);
      const onFailure =
        (node.props.onFailure as "compensate" | "compensate-and-fail" | "fail") ??
        "compensate";
      const actionChildren: PlanNode[] = [];
      const compensationChildren: PlanNode[] = [];
      let specialIndex = 0;
      for (const child of node.children) {
        const nextPath =
          child.kind === "element" ? [...ctx.path, specialIndex++] : ctx.path;
        if (child.kind !== "element") continue;
        if (child.tag === "smithers:saga-actions") {
          let nestedIndex = 0;
          for (const nested of child.children) {
            const nestedPath =
              nested.kind === "element" ? [...nextPath, nestedIndex++] : nextPath;
            const built = walk(nested, {
              path: nestedPath,
              parentIsRalph: false,
              loopStack,
            });
            if (built) actionChildren.push(built);
          }
          continue;
        }
        if (child.tag === "smithers:saga-compensations") {
          let nestedIndex = 0;
          for (const nested of child.children) {
            const nestedPath =
              nested.kind === "element" ? [...nextPath, nestedIndex++] : nextPath;
            const built = walk(nested, {
              path: nestedPath,
              parentIsRalph: false,
              loopStack,
            });
            if (built) compensationChildren.push(built);
          }
          continue;
        }
        const built = walk(child, {
          path: nextPath,
          parentIsRalph: false,
          loopStack,
        });
        if (built) actionChildren.push(built);
      }
      return {
        kind: "saga",
        id,
        actionChildren,
        compensationChildren,
        onFailure,
      };
    }

    if (tag === "smithers:try-catch-finally") {
      const id = resolveStableId(node.props.id, "tcf", ctx.path);
      const tryChildren: PlanNode[] = [];
      const catchChildren: PlanNode[] = [];
      const finallyChildren: PlanNode[] = [];
      let specialIndex = 0;
      for (const child of node.children) {
        const nextPath =
          child.kind === "element" ? [...ctx.path, specialIndex++] : ctx.path;
        if (child.kind !== "element") continue;
        const target =
          child.tag === "smithers:tcf-catch"
            ? catchChildren
            : child.tag === "smithers:tcf-finally"
              ? finallyChildren
              : tryChildren;
        if (
          child.tag === "smithers:tcf-try" ||
          child.tag === "smithers:tcf-catch" ||
          child.tag === "smithers:tcf-finally"
        ) {
          let nestedIndex = 0;
          for (const nested of child.children) {
            const nestedPath =
              nested.kind === "element" ? [...nextPath, nestedIndex++] : nextPath;
            const built = walk(nested, {
              path: nestedPath,
              parentIsRalph: false,
              loopStack,
            });
            if (built) target.push(built);
          }
          continue;
        }
        const built = walk(child, {
          path: nextPath,
          parentIsRalph: false,
          loopStack,
        });
        if (built) tryChildren.push(built);
      }
      return {
        kind: "try-catch-finally",
        id,
        tryChildren,
        catchChildren,
        finallyChildren,
      };
    }

    const children: PlanNode[] = [];
    let elementIndex = 0;
    const isRalph = tag === "smithers:ralph";
    for (const child of node.children) {
      const nextPath =
        child.kind === "element" ? [...ctx.path, elementIndex++] : ctx.path;
      const built = walk(child, {
        path: nextPath,
        parentIsRalph: isRalph,
        loopStack,
      });
      if (built) children.push(built);
    }

    if (tag === "smithers:task") {
      const logicalId = node.props.id;
      if (!logicalId) return null;
      const ancestorScope =
        loopStack.length > 1 ? buildLoopScope(loopStack.slice(0, -1)) : "";
      return { kind: "task", nodeId: logicalId + ancestorScope };
    }
    if (tag === "smithers:workflow" || tag === "smithers:sequence") {
      return { kind: "sequence", children };
    }
    if (tag === "smithers:parallel" || tag === "smithers:merge-queue") {
      return { kind: "parallel", children };
    }
    if (tag === "smithers:worktree") {
      return { kind: "group", children };
    }
    if (tag === "smithers:subflow") {
      const mode = node.props.mode ?? "childRun";
      if (mode === "inline") {
        return { kind: "sequence", children };
      }
      const logicalId = node.props.id;
      if (!logicalId) return null;
      const ancestorScope =
        loopStack.length > 1 ? buildLoopScope(loopStack.slice(0, -1)) : "";
      return { kind: "task", nodeId: logicalId + ancestorScope };
    }
    if (
      tag === "smithers:sandbox" ||
      tag === "smithers:wait-for-event" ||
      tag === "smithers:timer"
    ) {
      const logicalId = node.props.id;
      if (!logicalId) return null;
      const ancestorScope =
        loopStack.length > 1 ? buildLoopScope(loopStack.slice(0, -1)) : "";
      return { kind: "task", nodeId: logicalId + ancestorScope };
    }
    if (tag === "smithers:continue-as-new") {
      return { kind: "continue-as-new", stateJson: node.props.stateJson };
    }
    if (tag === "smithers:ralph") {
      const id = scopedRalphId!;
      if (seenRalph.has(id)) {
        throw new SmithersError(
          "DUPLICATE_ID",
          `Duplicate Ralph id detected: ${id}`,
          { kind: "ralph", id },
        );
      }
      seenRalph.add(id);
      const parsedContinueAsNewEvery = Math.floor(
        parseNum(node.props.continueAsNewEvery, 0),
      );
      const continueAsNewEvery =
        Number.isFinite(parsedContinueAsNewEvery) && parsedContinueAsNewEvery > 0
          ? parsedContinueAsNewEvery
          : undefined;
      const meta: RalphMeta = {
        id,
        until: parseBool(node.props.until),
        maxIterations: parseNum(node.props.maxIterations, 5),
        onMaxReached:
          (node.props.onMaxReached as "fail" | "return-last") ?? "return-last",
        continueAsNewEvery,
      };
      ralphs.push(meta);
      return {
        kind: "ralph",
        id,
        children,
        until: meta.until,
        maxIterations: meta.maxIterations,
        onMaxReached: meta.onMaxReached,
        continueAsNewEvery,
      };
    }
    return { kind: "group", children };
  }

  const plan = walk(xml, { path: [], parentIsRalph: false, loopStack: [] });
  return { plan, ralphs };
}

function isTerminal(state: TaskState, descriptor: TaskDescriptor): boolean {
  if (state === "finished" || state === "skipped") return true;
  if (state === "failed") return descriptor.continueOnFail;
  return false;
}

function isTraversalTerminal(state: TaskState, descriptor: TaskDescriptor): boolean {
  if (isTerminal(state, descriptor)) return true;
  return Boolean(
    descriptor.waitAsync &&
      (state === "waiting-approval" || state === "waiting-event"),
  );
}

function dependenciesSatisfied(
  descriptor: TaskDescriptor,
  states: TaskStateMap,
  descriptors: Map<string, TaskDescriptor>,
): boolean {
  if (!descriptor.dependsOn || descriptor.dependsOn.length === 0) return true;
  for (const dependencyId of descriptor.dependsOn) {
    const dependency = descriptors.get(dependencyId);
    if (!dependency) return false;
    const state = states.get(buildStateKey(dependency.nodeId, dependency.iteration));
    if (!state || !isTerminal(state, dependency)) {
      return false;
    }
  }
  return true;
}

export function scheduleTasks(
  plan: PlanNode | null,
  states: TaskStateMap,
  descriptors: Map<string, TaskDescriptor>,
  ralphState: RalphStateMap,
  retryWait: RetryWaitMap,
  nowMs: number,
): ScheduleResult {
  const runnable: TaskDescriptor[] = [];
  let pendingExists = false;
  let waitingApprovalExists = false;
  let waitingEventExists = false;
  let waitingTimerExists = false;
  const readyRalphs: RalphMeta[] = [];
  let continuation: ContinuationRequest | undefined;
  let nextRetryAtMs: number | undefined;
  let fatalError: string | undefined;

  const groupUsage = new Map<string, number>();
  for (const [stateKey, state] of states) {
    if (state !== "in-progress") continue;
    const separator = stateKey.lastIndexOf("::");
    const nodeId = separator >= 0 ? stateKey.slice(0, separator) : stateKey;
    const descriptor = descriptors.get(nodeId);
    if (!descriptor) continue;
    const groupId = descriptor.parallelGroupId;
    const cap = descriptor.parallelMaxConcurrency;
    if (groupId && cap != null) {
      groupUsage.set(groupId, (groupUsage.get(groupId) ?? 0) + 1);
    }
  }

  function inspect(node: PlanNode): { readonly terminal: boolean; readonly failed: boolean } {
    switch (node.kind) {
      case "task": {
        const descriptor = descriptors.get(node.nodeId);
        if (!descriptor) return { terminal: true, failed: false };
        const state =
          states.get(buildStateKey(descriptor.nodeId, descriptor.iteration)) ??
          "pending";
        const terminal =
          state === "finished" ||
          state === "skipped" ||
          state === "failed" ||
          Boolean(
            descriptor.waitAsync &&
              (state === "waiting-approval" || state === "waiting-event"),
          );
        return { terminal, failed: state === "failed" };
      }
      case "sequence":
      case "group": {
        for (const child of node.children) {
          const result = inspect(child);
          if (!result.terminal) return { terminal: false, failed: false };
          if (result.failed) return { terminal: true, failed: true };
        }
        return { terminal: true, failed: false };
      }
      case "parallel": {
        let terminal = true;
        let failed = false;
        for (const child of node.children) {
          const result = inspect(child);
          if (!result.terminal) terminal = false;
          if (result.failed) failed = true;
        }
        return { terminal, failed: terminal && failed };
      }
      case "saga": {
        for (const child of node.actionChildren) {
          const result = inspect(child);
          if (!result.terminal) return { terminal: false, failed: false };
          if (result.failed) return { terminal: true, failed: true };
        }
        return { terminal: true, failed: false };
      }
      case "try-catch-finally": {
        for (const child of node.tryChildren) {
          const result = inspect(child);
          if (!result.terminal) return { terminal: false, failed: false };
          if (result.failed) return { terminal: true, failed: true };
        }
        return { terminal: true, failed: false };
      }
      default:
        return { terminal: true, failed: false };
    }
  }

  function walkSequence(children: readonly PlanNode[]) {
    for (const child of children) {
      const result = walk(child);
      if (!result.terminal) return { terminal: false };
    }
    return { terminal: true };
  }

  function walk(node: PlanNode): { readonly terminal: boolean } {
    switch (node.kind) {
      case "task": {
        const descriptor = descriptors.get(node.nodeId);
        if (!descriptor) return { terminal: true };
        const state =
          states.get(buildStateKey(descriptor.nodeId, descriptor.iteration)) ??
          "pending";
        if (state === "waiting-approval") waitingApprovalExists = true;
        if (state === "waiting-event") waitingEventExists = true;
        if (state === "waiting-timer") waitingTimerExists = true;
        if (state === "pending" || state === "cancelled") pendingExists = true;
        const terminal = isTraversalTerminal(state, descriptor);
        if (!terminal && (state === "pending" || state === "cancelled")) {
          if (!dependenciesSatisfied(descriptor, states, descriptors)) {
            return { terminal };
          }
          const retryAt = retryWait.get(
            buildStateKey(descriptor.nodeId, descriptor.iteration),
          );
          if (retryAt && retryAt > nowMs) {
            pendingExists = true;
            nextRetryAtMs =
              nextRetryAtMs == null ? retryAt : Math.min(nextRetryAtMs, retryAt);
            return { terminal };
          }
          const groupId = descriptor.parallelGroupId;
          const cap = descriptor.parallelMaxConcurrency;
          if (groupId && cap != null) {
            const used = groupUsage.get(groupId) ?? 0;
            if (used >= cap) {
              return { terminal };
            }
            groupUsage.set(groupId, used + 1);
          }
          runnable.push(descriptor);
        }
        return { terminal };
      }
      case "sequence":
        return walkSequence(node.children);
      case "parallel": {
        let terminal = true;
        for (const child of node.children) {
          const result = walk(child);
          if (!result.terminal) terminal = false;
        }
        return { terminal };
      }
      case "ralph": {
        const state = ralphState.get(node.id);
        const done = node.until || state?.done;
        if (done) return { terminal: true };
        let terminal = true;
        for (const child of node.children) {
          const result = walk(child);
          if (!result.terminal) terminal = false;
        }
        if (terminal) {
          readyRalphs.push({
            id: node.id,
            until: node.until,
            maxIterations: node.maxIterations,
            onMaxReached: node.onMaxReached,
            continueAsNewEvery: node.continueAsNewEvery,
          });
        }
        return { terminal: false };
      }
      case "continue-as-new":
        continuation = { stateJson: node.stateJson };
        return { terminal: false };
      case "saga": {
        let completedActions = 0;
        let failed = false;
        for (const child of node.actionChildren) {
          const status = inspect(child);
          if (!status.terminal) return walk(child);
          if (status.failed) {
            failed = true;
            break;
          }
          completedActions += 1;
        }
        if (!failed) return { terminal: true };
        if (node.onFailure === "fail") {
          fatalError ??= `Saga ${node.id} failed`;
          return { terminal: true };
        }
        for (let index = completedActions - 1; index >= 0; index -= 1) {
          const compensation = node.compensationChildren[index];
          if (!compensation) continue;
          const result = walk(compensation);
          if (!result.terminal) return { terminal: false };
        }
        if (node.onFailure === "compensate-and-fail") {
          fatalError ??= `Saga ${node.id} failed`;
        }
        return { terminal: true };
      }
      case "try-catch-finally": {
        let tryFailed = false;
        for (const child of node.tryChildren) {
          const status = inspect(child);
          if (!status.terminal) return walk(child);
          if (status.failed) {
            tryFailed = true;
            break;
          }
        }
        if (tryFailed) {
          if (node.catchChildren.length > 0) {
            const catchResult = walkSequence(node.catchChildren);
            if (!catchResult.terminal) return catchResult;
          } else {
            fatalError ??= `TryCatchFinally ${node.id} failed`;
          }
        }
        const finallyResult = walkSequence(node.finallyChildren);
        if (!finallyResult.terminal) return finallyResult;
        return { terminal: true };
      }
      case "group": {
        let terminal = true;
        for (const child of node.children) {
          const result = walk(child);
          if (!result.terminal) terminal = false;
        }
        return { terminal };
      }
      default:
        return { terminal: true };
    }
  }

  if (plan) walk(plan);

  return {
    runnable,
    pendingExists,
    waitingApprovalExists,
    waitingEventExists,
    waitingTimerExists,
    readyRalphs,
    continuation,
    nextRetryAtMs,
    fatalError,
  };
}

export { buildStateKey };

export const SchedulerLive = Layer.effect(
  Scheduler,
  Effect.gen(function* () {
    const metrics = yield* MetricsService;
    const tracing = yield* TracingService;
    return {
      schedule: (plan, states, descriptors, ralphState, retryWait, nowMs) =>
        tracing.withSpan(
          "smithers.scheduler.schedule",
          Effect.sync(() =>
            scheduleTasks(plan, states, descriptors, ralphState, retryWait, nowMs),
          ).pipe(
            Effect.tap((result) =>
              metrics.gauge("smithers.scheduler.queue_depth", result.runnable.length),
            ),
          ),
          { runnableInputs: descriptors.size },
        ),
    };
  }),
);
