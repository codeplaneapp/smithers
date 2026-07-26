import { claudeSeats, codexSeats } from "../accounts/accountAgents";

/**
 * Sandwich routing (spec §6): Fable plans and gates, Terra/Sol implement, Opus
 * reviews, Luna does mechanical work.
 *
 * Every seat is an ORDERED FALLBACK CHAIN across the registered account fleet,
 * not a single agent, for two reasons:
 *
 *  1. Load balancing. A campaign this size cannot run on one subscription. The
 *     chain is ordered by live per-account headroom from the usage snapshot
 *     (see ../accounts/accountPool), conserving scarce Fable capacity for the
 *     work only Fable does.
 *  2. Failover. `agent={[primary, ...fallbacks]}` advances on preflight or
 *     mid-attempt failure, so an account hitting its window costs one hop
 *     instead of parking the run — the failure mode that killed several
 *     multi-hour rounds when every Claude seat pointed at one account.
 *
 * The module-level seats below are resolved once per run, which is the right
 * granularity for a milestone-per-run campaign: each run re-reads the snapshot,
 * and within a run the chain absorbs quota death. Anything that FANS OUT should
 * use the per-lane functions instead, so concurrent lanes land on different
 * accounts rather than stacking on the same one.
 *
 * Account binding is `configDir` (CLAUDE_CONFIG_DIR / CODEX_HOME) and every
 * Claude seat blanks ANTHROPIC_API_KEY — see ../accounts/accountAgents.
 */

/* ── singleton seats: stable call sites, resolved once per run ── */

export const fable = claudeSeats("claude-fable-5");
export const opus = claudeSeats("claude-opus-4-8");
export const sol = codexSeats("gpt-5.6-sol");
export const terra = codexSeats("gpt-5.6-terra", "default", "high");
export const luna = codexSeats("gpt-5.6-luna", "default", "medium");

/** Planning/gating seat: Fable first, Opus behind it. */
export const planner = [...fable, ...opus];

/** Mechanical seat: cheap tier first, escalating only if the cheap tier dies. */
export const mechanical = [...luna, ...terra];

/* ── per-lane seats: use these anywhere lanes run concurrently ── */

/** Opus reviewer bound to this lane's slot in the fleet rotation. */
export const opusSeatsFor = (laneKey: string) => claudeSeats("claude-opus-4-8", laneKey);

/**
 * Implementer seat. Escalation swaps the Codex TIER order rather than the
 * family, so the model that implemented a slice is never the one reviewing it.
 */
export const implementerSeatsFor = (laneKey: string, escalated: boolean) =>
  escalated
    ? [...codexSeats("gpt-5.6-sol", laneKey), ...codexSeats("gpt-5.6-terra", laneKey, "high")]
    : [...codexSeats("gpt-5.6-terra", laneKey, "high"), ...codexSeats("gpt-5.6-sol", laneKey)];

/** The Codex reviewer tier, opposite whichever tier implemented this round. */
export const codexReviewerSeatsFor = (laneKey: string, escalated: boolean) =>
  escalated
    ? codexSeats("gpt-5.6-terra", laneKey, "high")
    : codexSeats("gpt-5.6-sol", laneKey);
