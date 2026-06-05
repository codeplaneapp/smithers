import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { config } from "./config.js";
import { loadInstances } from "./loadInstances.js";
import { runInstance } from "./runInstance.js";
import { summarizeResults } from "./summarizeResults.js";

/**
 * Run the benchmark over a selection of instances and write a JSON report.
 *
 * Instances run sequentially by default: the canonical images are amd64 and run
 * under emulation on Apple Silicon, and each instance already spawns its own
 * Opus + Codex subprocesses, so serial execution keeps the box responsive and
 * the timings honest. Set `concurrency > 1` only on a fast amd64 host.
 *
 * @param {object} opts
 * @param {string[]} [opts.ids]
 * @param {string[]} [opts.repos]
 * @param {string[]} [opts.languages]
 * @param {number} [opts.limit]
 * @param {string} [opts.implementerModel]
 * @param {string} [opts.reviewerModel]
 * @param {boolean} [opts.skipIntegrity]
 * @param {number} [opts.agentTimeoutMs]
 * @param {number} [opts.scoreTimeoutMs]
 * @param {string} [opts.reportPath]
 * @param {number} [opts.nowMs]              Wall-clock stamp (injected; no Date.now in lib).
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<object>}
 */
export async function runBenchmark(opts) {
  const log = opts.log ?? ((m) => console.log(m));
  const instances = loadInstances({
    ids: opts.ids,
    repos: opts.repos,
    languages: opts.languages,
    limit: opts.limit,
  });
  if (instances.length === 0) throw new Error("no instances matched the selection");

  log(`[bench] running ${instances.length} instance(s)`);
  const results = [];
  for (let i = 0; i < instances.length; i++) {
    const it = instances[i];
    log(`\n[bench] (${i + 1}/${instances.length}) ${it.instanceId}`);
    const r = await runInstance(it, {
      implementerModel: opts.implementerModel,
      reviewerModel: opts.reviewerModel,
      skipIntegrity: opts.skipIntegrity,
      agentTimeoutMs: opts.agentTimeoutMs,
      scoreTimeoutMs: opts.scoreTimeoutMs,
      log,
    });
    results.push(r);
    log(`[bench] ${it.instanceId}: ${r.verdict}`);
  }

  const report = summarizeResults(results, {
    dataset: `${config.upstream.dataset}:${config.upstream.datasetSplit}`,
    models: {
      implementer: opts.implementerModel ?? process.env.SWEBP_IMPLEMENTER_MODEL ?? "claude-opus-4-8",
      reviewer: opts.reviewerModel ?? process.env.SWEBP_REVIEWER_MODEL ?? "gpt-5.5",
    },
    integrityChecked: !opts.skipIntegrity,
    finishedAtMs: opts.nowMs ?? null,
  });

  const reportPath = opts.reportPath ?? join(config.workDir, "reports", `report-${opts.nowMs ?? "latest"}.json`);
  mkdirSync(join(reportPath, ".."), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  log(`\n[bench] report written to ${reportPath}`);
  log(
    `[bench] Pass@1 = ${report.totals.resolved}/${report.totals.counted} = ${(report.totals.passAt1 * 100).toFixed(1)}%` +
      (report.totals.excludedIntegrity ? ` (excluded ${report.totals.excludedIntegrity} for integrity)` : "") +
      (report.totals.errored ? ` (errored ${report.totals.errored})` : ""),
  );
  return report;
}
