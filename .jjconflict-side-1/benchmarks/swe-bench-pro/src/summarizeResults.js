/**
 * Aggregate per-instance results into a benchmark report. The headline metric is
 * Pass@1 over *counted* instances — those where the harness proved sound
 * (gold resolved, empty failed). Instances excluded for harness/integrity
 * reasons or hard errors are reported explicitly and separately so the headline
 * cannot be inflated by quietly dropping hard cases.
 *
 * @param {import("./runInstance.js").InstanceResult[]} results
 * @param {object} [meta]
 * @returns {object}
 */
export function summarizeResults(results, meta = {}) {
  const counted = results.filter((r) => r.counted);
  const resolved = counted.filter((r) => r.resolved);
  const excludedIntegrity = results.filter((r) => r.verdict === "excluded-integrity");
  const excludedNoTests = results.filter((r) => r.verdict === "excluded-no-tests");
  const errored = results.filter((r) => r.verdict === "error");
  // When integrity controls were skipped, counted instances were NOT proven
  // sound (gold resolves / empty fails). Such numbers are not publishable as
  // canonical — surface that loudly instead of letting integrityValid=null pass
  // for validated.
  const integrityChecked = meta.integrityChecked !== false;
  const warning = integrityChecked
    ? null
    : "INTEGRITY CONTROLS SKIPPED — counted instances were not proven sound (gold/empty not run). These numbers are exploratory, not canonical.";

  /** @param {import("./runInstance.js").InstanceResult[]} group */
  const groupStats = (keyFn) => {
    /** @type {Record<string, { counted: number, resolved: number }>} */
    const acc = {};
    for (const r of results) {
      const key = keyFn(r);
      acc[key] ??= { counted: 0, resolved: 0 };
      if (r.counted) {
        acc[key].counted += 1;
        if (r.resolved) acc[key].resolved += 1;
      }
    }
    return acc;
  };

  return {
    generatedNote:
      "Pass@1 is over counted instances only. Excluded/errored instances are listed separately and never counted as passes.",
    warning,
    ...meta,
    totals: {
      attempted: results.length,
      counted: counted.length,
      resolved: resolved.length,
      unresolved: counted.length - resolved.length,
      excludedIntegrity: excludedIntegrity.length,
      excludedNoTests: excludedNoTests.length,
      errored: errored.length,
      passAt1: counted.length ? resolved.length / counted.length : 0,
    },
    byLanguage: groupStats((r) => r.repoLanguage),
    byRepo: groupStats((r) => r.repo),
    excluded: excludedIntegrity.map((r) => ({
      instanceId: r.instanceId,
      reason: r.integrity
        ? `gold=${r.integrity.goldResolved} empty=${r.integrity.emptyResolved}`
        : "unknown",
    })),
    errors: errored.map((r) => ({ instanceId: r.instanceId, error: r.error?.split("\n")[0] })),
    results: results.map((r) => ({
      instanceId: r.instanceId,
      repo: r.repo,
      repoLanguage: r.repoLanguage,
      verdict: r.verdict,
      resolved: r.resolved,
      counted: r.counted,
      integrityValid: r.integrityValid,
      patchBytes: r.patchBytes,
      missingTests: r.missingTests,
      durationMs: r.durationMs,
      runId: r.runId,
    })),
  };
}
