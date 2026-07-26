/// <reference path="../types/bun-test-shim.d.ts" />
/**
 * Catalog campaign: run a list of scenario runners with optional herdr + repeat.
 */
type CampaignScenarioResult = {
    id: string;
    ok: boolean;
    error?: string;
    runId?: string;
    durationMs: number;
    herdr?: boolean;
};
type CampaignScenario = {
    /** Stable catalog id (hello, sequence, …). */
    id: string;
    /** Short description for logs / human checklist. */
    title: string;
    /**
     * Run the scenario. Receives campaign context (herdr session, run id prefix).
     * Should throw on failure.
     */
    run: (ctx: CampaignRunContext) => Promise<{
        runId?: string;
        herdr?: boolean;
    } | void>;
};
type CampaignRunContext = {
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
type RunCampaignOptions = {
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
type CampaignReport = {
    ok: boolean;
    results: CampaignScenarioResult[];
    iterations: number;
    herdr: boolean;
};
/**
 * Run the scenario catalog as a campaign (machine loop for B/C gates).
 */
declare function runCampaign(options: RunCampaignOptions): Promise<CampaignReport>;

export { type CampaignReport, type CampaignRunContext, type CampaignScenario, type CampaignScenarioResult, type RunCampaignOptions, runCampaign };
