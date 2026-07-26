// src/campaign.ts
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
async function runCampaign(options) {
  const log = options.log ?? ((msg) => console.log(msg));
  const repeat = Math.max(1, options.repeat ?? 1);
  const onFail = options.onFail ?? "stop";
  const herdr = options.herdr === true;
  const campaignId = `camp-${Date.now().toString(36)}`;
  let scenarios = options.scenarios;
  if (options.only?.length) {
    const allow = new Set(options.only);
    scenarios = scenarios.filter((s) => allow.has(s.id));
  }
  const results = [];
  log(
    `[campaign] start id=${campaignId} scenarios=${scenarios.length} repeat=${repeat} herdr=${herdr}` + (options.herdrSession ? ` session=${options.herdrSession}` : "")
  );
  for (let iteration = 0; iteration < repeat; iteration++) {
    log(`[campaign] iteration ${iteration + 1}/${repeat}`);
    for (const scenario of scenarios) {
      const t0 = Date.now();
      log(`[campaign] \u2192 ${scenario.id}: ${scenario.title}`);
      try {
        if (options.onScenarioStart) {
          await options.onScenarioStart({ scenario, iteration, campaignId });
        }
        const out = await scenario.run({
          iteration,
          herdr,
          herdrSession: options.herdrSession,
          requireHerdr: options.requireHerdr === true,
          liveUi: options.liveUi === true,
          opsMode: options.opsMode === true,
          campaignId,
          log
        });
        if (options.requireHerdr && herdr && out && out.herdr === false) {
          throw new Error(
            `herdr required but scenario ${scenario.id} did not attach a mirror (is herdr --session ${options.herdrSession ?? "default"} running?)`
          );
        }
        const durationMs = Date.now() - t0;
        results.push({
          id: scenario.id,
          ok: true,
          runId: out?.runId,
          herdr: out?.herdr,
          durationMs
        });
        log(`[campaign] \u2713 ${scenario.id} (${durationMs}ms)`);
      } catch (err) {
        const durationMs = Date.now() - t0;
        const error = err instanceof Error ? err.message : String(err);
        results.push({ id: scenario.id, ok: false, error, durationMs });
        log(`[campaign] \u2717 ${scenario.id}: ${error}`);
        if (onFail === "stop") {
          return { ok: false, results, iterations: iteration + 1, herdr };
        }
      }
      if (options.pauseMs && options.pauseMs > 0) {
        await sleep(options.pauseMs);
      }
    }
    if (iteration + 1 < repeat && options.iterationPauseMs && options.iterationPauseMs > 0) {
      await sleep(options.iterationPauseMs);
    }
  }
  const ok = results.every((r) => r.ok);
  log(`[campaign] done ok=${ok} results=${results.length}`);
  return { ok, results, iterations: repeat, herdr };
}
export {
  runCampaign
};
