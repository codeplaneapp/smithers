/**
 * Catalog campaign: run a list of scenario runners with optional herdr + repeat.
 */

export type CampaignScenarioResult = {
  id: string;
  ok: boolean;
  error?: string;
  runId?: string;
  durationMs: number;
  herdr?: boolean;
};

export type CampaignScenario = {
  /** Stable catalog id (hello, sequence, …). */
  id: string;
  /** Short description for logs / human checklist. */
  title: string;
  /**
   * Run the scenario. Receives campaign context (herdr session, run id prefix).
   * Should throw on failure.
   */
  run: (ctx: CampaignRunContext) => Promise<{ runId?: string; herdr?: boolean } | void>;
};

export type CampaignRunContext = {
  /** 0-based iteration of the outer campaign loop. */
  iteration: number;
  /** Optional herdr session name. */
  herdrSession?: string;
  /** When true, scenarios should attach herdr if possible. */
  herdr: boolean;
  /**
   * When true with herdr, scenarios must attach herdr (throw if soft-skip).
   * Default false for unit tests; CLI sets true for human watch.
   */
  requireHerdr?: boolean;
  /**
   * Human UI mode: real `smithers tail` panes + wall-clock 2–5s LLM pacing.
   * Machine tests keep this false (sleep stubs + virtual clock).
   */
  liveUi?: boolean;
  /**
   * Operator-first dual-control: dock into focused herdr workspace
   * (left harness owned by human, right overview HUD).
   */
  opsMode?: boolean;
  /** Unique suffix for this campaign run. */
  campaignId: string;
  log: (msg: string) => void;
};

export type RunCampaignOptions = {
  scenarios: CampaignScenario[];
  /** How many times to run the full catalog. Default 1. */
  repeat?: number;
  /** Pause between scenarios (ms). Default 0. */
  pauseMs?: number;
  /** Pause between catalog iterations (ms). Default 0. */
  iterationPauseMs?: number;
  herdr?: boolean;
  herdrSession?: string;
  /** Fail scenario if herdr was requested but could not attach. */
  requireHerdr?: boolean;
  /**
   * Human watch: live smithers tail + real-time pacing (CLI default when --herdr).
   */
  liveUi?: boolean;
  /** Operator-first dock mode (left harness / right HUD). */
  opsMode?: boolean;
  /**
   * Called before each scenario (e.g. close prior campaign workspaces).
   */
  onScenarioStart?: (info: {
    scenario: CampaignScenario;
    iteration: number;
    campaignId: string;
  }) => void | Promise<void>;
  /** stop = abort campaign on first failure; continue = record and proceed. Default stop. */
  onFail?: "stop" | "continue";
  log?: (msg: string) => void;
  /** Filter scenario ids (exact). */
  only?: string[];
  /** When true, caller will reset herdr between scenarios (hook only — CLI implements). */
  resetBetween?: boolean;
};

export type CampaignReport = {
  ok: boolean;
  results: CampaignScenarioResult[];
  iterations: number;
  herdr: boolean;
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Run the scenario catalog as a campaign (machine loop for B/C gates).
 */
export async function runCampaign(options: RunCampaignOptions): Promise<CampaignReport> {
  const log = options.log ?? ((msg: string) => console.log(msg));
  const repeat = options.repeat ?? 1;
  if (!Number.isSafeInteger(repeat) || repeat < 1) {
    throw new TypeError(`campaign repeat must be a positive safe integer, got ${String(repeat)}`);
  }
  const onFail = options.onFail ?? "stop";
  const herdr = options.herdr === true;
  const campaignId = `camp-${Date.now().toString(36)}`;
  let scenarios = options.scenarios;
  if (options.only?.length) {
    const known = new Set(scenarios.map((scenario) => scenario.id));
    const unknown = options.only.filter((id) => !known.has(id));
    if (unknown.length > 0) throw new TypeError(`Unknown campaign scenario id(s): ${unknown.join(", ")}`);
    const allow = new Set(options.only);
    scenarios = scenarios.filter((s) => allow.has(s.id));
  }
  const results: CampaignScenarioResult[] = [];

  log(
    `[campaign] start id=${campaignId} scenarios=${scenarios.length} repeat=${repeat} herdr=${herdr}` +
      (options.herdrSession ? ` session=${options.herdrSession}` : ""),
  );

  for (let iteration = 0; iteration < repeat; iteration++) {
    log(`[campaign] iteration ${iteration + 1}/${repeat}`);
    for (const scenario of scenarios) {
      const t0 = Date.now();
      log(`[campaign] → ${scenario.id}: ${scenario.title}`);
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
          log,
        });
        if (options.requireHerdr && herdr && out?.herdr !== true) {
          throw new Error(
            `herdr required but scenario ${scenario.id} did not attach a mirror (is herdr --session ${options.herdrSession ?? "default"} running?)`,
          );
        }
        const durationMs = Date.now() - t0;
        results.push({
          id: scenario.id,
          ok: true,
          runId: out?.runId,
          herdr: out?.herdr,
          durationMs,
        });
        log(`[campaign] ✓ ${scenario.id} (${durationMs}ms)`);
      } catch (err) {
        const durationMs = Date.now() - t0;
        const error = err instanceof Error ? err.message : String(err);
        results.push({ id: scenario.id, ok: false, error, durationMs });
        log(`[campaign] ✗ ${scenario.id}: ${error}`);
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
