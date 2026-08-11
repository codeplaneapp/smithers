/**
 * Thin workflow scenario runner: real runWorkflow + optional hooks.
 * Does not own createSmithers (avoids smithers↔testing cycles); pass a pre-built workflow.
 *
 * Distinct from the durability-kernel `runScenario(ast, …)` — that API takes a ScenarioAst.
 */

import { type VirtualClock, createVirtualClock } from "./virtualClock.ts";
import { loadOptionalSmthrs } from "./loadOptionalSmthrs.ts";
import { randomUUID } from "node:crypto";

/** Structural workflow definition (smithers() return value). */
export type ScenarioWorkflow = {
  build?: unknown;
  opts?: unknown;
  [key: string]: unknown;
};

export type RunWorkflowScenarioOptions = {
  /** Workflow from createSmithers(...). */
  workflow: ScenarioWorkflow;
  input?: unknown;
  runId?: string;
  /** Absolute project root for the run (defaults to process.cwd()). */
  rootDir?: string;
  /** When true, resume an existing runId. */
  resume?: boolean;
  clock?: VirtualClock;
  /** Called with the resolved runId before runWorkflow. */
  beforeRun?: (ctx: { runId: string; clock: VirtualClock }) => void | Promise<void>;
  /** Live progress events from the engine. */
  onProgress?: (event: unknown) => void;
  /**
   * Injected runWorkflow. Defaults to dynamic import of smthrs.
   * May return an Effect or a Promise.
   */
  runWorkflowFn?: (workflow: ScenarioWorkflow, opts: Record<string, unknown>) => unknown;
};

export type WorkflowScenarioResult = {
  runId: string;
  status: string;
  result: Record<string, unknown>;
  clock: VirtualClock;
};

function isEffectLike(value: unknown): value is { pipe: (...args: unknown[]) => unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    "pipe" in value &&
    typeof (value as { pipe?: unknown }).pipe === "function"
  );
}

async function settleRunResult(raw: unknown): Promise<Record<string, unknown>> {
  let value: unknown = raw;
  if (isEffectLike(value)) {
    const { Effect } = await import("effect");
    value = await Effect.runPromise(value as never);
  }
  if (value && typeof value === "object" && "then" in value && typeof (value as Promise<unknown>).then === "function") {
    value = await value;
  }
  if (value && typeof value === "object") {
    return value as Record<string, unknown>;
  }
  return { value };
}

/**
 * Run a workflow definition to completion (or park). Token-free when agents are scripted.
 */
export async function runWorkflowScenario(options: RunWorkflowScenarioOptions): Promise<WorkflowScenarioResult> {
  const runId = typeof options.runId === "string" && options.runId !== "" ? options.runId : `scenario-${randomUUID()}`;
  const clock = options.clock ?? createVirtualClock();

  if (options.beforeRun) {
    await options.beforeRun({ runId, clock });
  }

  const rootDir = typeof options.rootDir === "string" && options.rootDir !== "" ? options.rootDir : process.cwd();

  const runOpts: Record<string, unknown> = {
    runId,
    rootDir,
    // Engine requires input object (even empty).
    input: options.input ?? {},
    resume: options.resume === true,
  };
  if (options.onProgress) {
    runOpts.onProgress = options.onProgress;
  }

  let runWorkflowFn = options.runWorkflowFn;
  if (!runWorkflowFn) {
    const mod = (await loadOptionalSmthrs(
      "Install smthrs to use runWorkflowScenario, or pass runWorkflowFn",
    )) as unknown as {
      runWorkflow?: (wf: ScenarioWorkflow, opts: Record<string, unknown>) => unknown;
    };
    const rw = mod.runWorkflow;
    if (typeof rw !== "function") {
      throw new Error("runWorkflowScenario: smthrs.runWorkflow not available; pass runWorkflowFn");
    }
    runWorkflowFn = rw;
  }

  const raw = await Promise.resolve(runWorkflowFn(options.workflow, runOpts));
  const result = await settleRunResult(raw);
  const status =
    typeof result.status === "string"
      ? result.status
      : typeof (result as { run?: { status?: string } }).run?.status === "string"
        ? String((result as { run: { status: string } }).run.status)
        : "unknown";
  const resolvedRunId =
    typeof result.runId === "string" && result.runId !== ""
      ? result.runId
      : typeof (result as { run?: { runId?: string } }).run?.runId === "string"
        ? String((result as { run: { runId: string } }).run.runId)
        : runId;

  return {
    runId: resolvedRunId,
    status,
    result,
    clock,
  };
}

/** @deprecated Prefer {@link runWorkflowScenario}; kept for campaign test imports. */
export const runScenario = runWorkflowScenario;
