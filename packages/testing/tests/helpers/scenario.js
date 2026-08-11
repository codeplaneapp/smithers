/**
 * Shared helpers for core workflow scenario tests (token-free, real engine).
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { runWorkflow } from "smthrs";
import { loadAgentTraceVector, scriptedAgent, createVirtualClock } from "../../src/index.ts";

export const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/agent-traces");

export function loadFixture(name) {
  const file = name.endsWith(".json") ? name : `${name}.v1.json`;
  return loadAgentTraceVector(join(FIXTURES_DIR, file));
}

export function agentFromFixture(name, opts = {}) {
  const clock = opts.clock ?? createVirtualClock();
  const { clock: _c, ...rest } = opts;
  return scriptedAgent(loadFixture(name), { ...rest, clock });
}

export function runInRoot(workflow, dbPath, opts) {
  return Effect.runPromise(
    runWorkflow(workflow, {
      ...opts,
      rootDir: dirname(dbPath),
    }),
  );
}

export function scenarioRunWorkflowFn(dbPath) {
  return (wf, opts) => runInRoot(wf, dbPath, opts);
}
