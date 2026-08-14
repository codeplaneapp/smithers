// @smithers-type-exports-begin
/** @typedef {import("@smthrs/driver/RuntimeAdapter").RuntimeAdapter} RuntimeAdapter */
/** @typedef {import("@smthrs/driver/browser-runtime").BrowserRuntimeOptions} BrowserRuntimeOptions */
// @smithers-type-exports-end

import React from "react";
import { Effect } from "effect";
import { WorkflowDriver } from "@smthrs/driver/WorkflowDriver";
import { createBrowserRuntime as createBrowserRuntimeImpl } from "@smthrs/driver/browser-runtime";
import { makeWorkflowSession } from "@smthrs/scheduler";
import { SmithersRenderer } from "@smthrs/react-reconciler";
import { SmithersContext } from "@smthrs/react-reconciler/context";
import { extractGraph } from "@smthrs/graph/extract";

export { RuntimeCapabilityError, RUNTIME_CAPABILITY_UNAVAILABLE } from "@smthrs/driver/RuntimeCapabilityError";
export { Task } from "@smthrs/components/components/Task.browser";
export { Workflow } from "@smthrs/components/components/Workflow";
export { Sequence } from "@smthrs/components/components/Sequence";
export { Worktree } from "@smthrs/components/components/Worktree";

/**
 * Build a browser workflow definition from a `(ctx) => ReactNode` builder —
 * the same shape `createSmithers().smithers(build)` produces for the Node
 * engine, minus the Node-only options (`db`, CLI-agent defaults, ...) that
 * make no sense in a browser.
 * @template Schema
 * @param {(ctx: import("@smthrs/driver/SmithersCtx").SmithersCtx<Schema>) => React.ReactNode} build
 * @param {{ zodToKeyName?: Map<unknown, string> }} [opts]
 * @returns {{ build: (ctx: unknown) => React.ReactNode; zodToKeyName?: Map<unknown, string> }}
 */
export function defineBrowserWorkflow(build, opts = {}) {
  return { build, zodToKeyName: opts.zodToKeyName };
}

/**
 * Build a production browser `RuntimeAdapter` — see `createBrowserRuntime` in
 * `@smthrs/driver/browser-runtime` for the full contract.
 * @param {BrowserRuntimeOptions} [options]
 * @returns {RuntimeAdapter}
 */
export function createBrowserRuntime(options) {
  return createBrowserRuntimeImpl(options);
}

/**
 * Create a runnable Smithers instance backed entirely by portable code: the
 * real `WorkflowDriver`, `SmithersRenderer`, `extractGraph`, and browser-safe
 * `Task`/`Workflow`/`Sequence`/`Worktree` primitives — the same workflow
 * surface the Node engine uses, minus the Node-only pieces (CLI agents,
 * database, subprocess/filesystem/sandbox) a `RuntimeAdapter` fails closed on.
 * @template Schema
 * @param {{
 *   workflow: { build: (ctx: unknown) => React.ReactNode; zodToKeyName?: Map<unknown, string> };
 *   runtime?: RuntimeAdapter;
 *   runtimeOptions?: BrowserRuntimeOptions;
 * }} options
 * @returns {{
 *   runtime: RuntimeAdapter;
 *   run: (runOptions?: { runId?: string; input?: unknown; signal?: AbortSignal }) => Promise<import("@smthrs/driver/RunResult").RunResult>;
 *   getRun: (runId: string) => Promise<import("@smthrs/driver/RuntimeAdapter").StoredRunState | undefined>;
 *   getOutputs: (runId: string) => Promise<Record<string, unknown[]> | undefined>;
 * }}
 */
export function createBrowserSmithers(options) {
  const runtime = options?.runtime ?? createBrowserRuntimeImpl(options?.runtimeOptions);
  const workflow = options?.workflow;
  if (!workflow || typeof workflow.build !== "function") {
    throw new TypeError("createBrowserSmithers requires a browser workflow definition — see defineBrowserWorkflow().");
  }
  const definition = {
    zodToKeyName: workflow.zodToKeyName,
    build: (ctx) => React.createElement(SmithersContext.Provider, { value: ctx }, workflow.build(ctx)),
  };
  const createDriver = () =>
    new WorkflowDriver({
      workflow: definition,
      runtime: { runPromise: (effect) => Effect.runPromise(effect) },
      renderer: new SmithersRenderer({ extractGraph }),
      runtimeAdapter: runtime,
      createSession: (sessionOptions) =>
        makeWorkflowSession({
          ...sessionOptions,
          nowMs: runtime.clock.now,
          // A task with `deps` that aren't ready yet renders null and defers
          // (see taskCore.js); it only appears in the graph on a LATER
          // render. Without this, the scheduler can decide "Finished" right
          // after the last known task completes, never re-rendering to pick
          // up a still-deferred dependent task. Matches the Node engine
          // (packages/engine/src/engine.js), which always sets this too.
          requireRerenderOnOutputChange: true,
        }),
    });
  return {
    runtime,
    run: (runOptions = {}) => createDriver().run(runOptions),
    getRun: (runId) => runtime.storage.loadRun(runId),
    getOutputs: (runId) => runtime.storage.loadOutputs(runId),
  };
}

/**
 * Convenience one-shot: build and immediately run a browser workflow.
 * @template Schema
 * @param {{ build: (ctx: unknown) => React.ReactNode; zodToKeyName?: Map<unknown, string> }} workflow
 * @param {{ runId?: string; input?: unknown; signal?: AbortSignal; runtime?: RuntimeAdapter }} [options]
 * @returns {Promise<import("@smthrs/driver/RunResult").RunResult>}
 */
export async function runBrowserWorkflow(workflow, options = {}) {
  const { runtime, ...runOptions } = options;
  return createBrowserSmithers({ workflow, runtime }).run(runOptions);
}
