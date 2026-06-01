import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { config } from "./config.js";
import { extractPatch } from "./extractPatch.js";
import { prepareCheckout } from "./prepareCheckout.js";
import { runWorkflowForInstance } from "./runWorkflowForInstance.js";
import { scorePatch } from "./scorePatch.js";
import { validateHarness } from "./validateHarness.js";

/**
 * @typedef {object} InstanceResult
 * @property {string} instanceId
 * @property {string} repo
 * @property {string} repoLanguage
 * @property {boolean} resolved        Did the agent's patch resolve the task?
 * @property {boolean|null} integrityValid  true/false if gold/empty controls ran; null if skipped.
 * @property {boolean} counted         Included in the headline metric?
 * @property {string} verdict          resolved | unresolved | excluded-integrity | excluded-no-tests | error
 * @property {number} patchBytes
 * @property {string[]} missingTests
 * @property {object} model            Full scorePatch result for the agent patch.
 * @property {object|null} integrity   validateHarness result (gold/empty).
 * @property {string} runId
 * @property {number} runExitCode
 * @property {boolean} runTimedOut
 * @property {number} durationMs
 */

/**
 * Run one SWE-Bench Pro instance end to end: extract a clean checkout, let the
 * Smithers workflow author a patch, then score that patch — and the gold/empty
 * controls — in the canonical Docker harness.
 *
 * A pass is only credited when BOTH the agent patch resolves AND the harness is
 * proven sound for this instance (gold resolves, empty fails). If the harness is
 * unsound (flaky/broken image), the instance is *excluded* and never silently
 * counted as a pass or a loss.
 *
 * @param {import("./loadInstances.js").SwebpInstance} instance
 * @param {object} [opts]
 * @param {string} [opts.implementerModel]
 * @param {string} [opts.reviewerModel]
 * @param {number} [opts.agentTimeoutMs]
 * @param {number} [opts.scoreTimeoutMs]
 * @param {boolean} [opts.skipIntegrity]   Skip gold/empty controls (faster, less rigorous).
 * @param {boolean} [opts.echo]
 * @param {(instance: any, repoDir: string, o: any) => Promise<{ code: number, runId: string, timedOut: boolean }>} [opts.runWorkflow]
 *        Strategy for executing the workflow. Defaults to `smithers up`; the
 *        gateway path injects a launch-via-RPC implementation here.
 * @param {(msg: string) => void} [opts.log]
 * @param {number} [opts.startedAtMs]
 * @returns {Promise<InstanceResult>}
 */
export async function runInstance(instance, opts = {}) {
  const log = opts.log ?? ((m) => console.log(m));
  const startedAtMs = opts.startedAtMs ?? Number(process.env.SWEBP_NOW_MS ?? 0);
  const t0 = performanceNow();
  const artifactDir = join(config.workDir, "results", instance.instanceId);
  mkdirSync(artifactDir, { recursive: true });

  const base = {
    instanceId: instance.instanceId,
    repo: instance.repo,
    repoLanguage: instance.repoLanguage,
  };

  try {
    const { repoDir } = await prepareCheckout(instance, log);

    const runWorkflow = opts.runWorkflow ?? runWorkflowForInstance;
    const run = await runWorkflow(instance, repoDir, {
      implementerModel: opts.implementerModel,
      reviewerModel: opts.reviewerModel,
      timeoutMs: opts.agentTimeoutMs ?? 35 * 60 * 1000,
      echo: opts.echo,
      log,
    });

    const patch = extractPatch(repoDir);
    writeFileSync(join(artifactDir, "model_patch.diff"), patch);
    log(`[patch] ${instance.instanceId}: captured ${patch.length} bytes of changes`);

    log(`[score] ${instance.instanceId}: scoring agent patch in canonical harness…`);
    const model = await scorePatch(instance, patch, {
      prefix: "model",
      timeoutMs: opts.scoreTimeoutMs,
    });
    log(`[score] ${instance.instanceId}: agent resolved=${model.resolved} (missing: ${model.missing.join(", ") || "none"})`);

    let integrity = null;
    if (!opts.skipIntegrity) {
      integrity = await validateHarness(instance, { timeoutMs: opts.scoreTimeoutMs, log });
    }
    // null = integrity was not run (skip-integrity); do NOT conflate with "valid".
    const integrityValid = integrity ? integrity.valid : null;

    let verdict;
    let counted = true;
    if (model.required.length === 0) {
      // No required tests ⇒ the instance cannot fairly distinguish a real fix
      // from a no-op; never count it (faithful to canonical, but not a free pass).
      verdict = "excluded-no-tests";
      counted = false;
    } else if (integrity && !integrity.valid) {
      verdict = "excluded-integrity";
      counted = false;
    } else {
      verdict = model.resolved ? "resolved" : "unresolved";
    }

    const result = {
      ...base,
      resolved: model.resolved,
      integrityValid,
      counted,
      verdict,
      patchBytes: patch.length,
      missingTests: model.missing,
      model,
      integrity,
      runId: run.runId,
      runExitCode: run.code,
      runTimedOut: run.timedOut,
      durationMs: Math.round(performanceNow() - t0),
    };
    writeFileSync(join(artifactDir, "result.json"), JSON.stringify(result, null, 2));
    return result;
  } catch (err) {
    log(`[error] ${instance.instanceId}: ${err?.message ?? err}`);
    const result = {
      ...base,
      resolved: false,
      integrityValid: null,
      counted: false,
      verdict: "error",
      patchBytes: 0,
      missingTests: [],
      model: null,
      integrity: null,
      runId: "",
      runExitCode: -1,
      runTimedOut: false,
      durationMs: Math.round(performanceNow() - t0),
      error: String(err?.stack ?? err),
    };
    writeFileSync(join(artifactDir, "result.json"), JSON.stringify(result, null, 2));
    return result;
  }
}

function performanceNow() {
  return Number(process.hrtime.bigint() / 1000000n);
}
