import { ClaudeCodeAgent } from "smthrs";
import type { BuildFleetTiersOptions } from "./BuildFleetTiersOptions";
import { defaultFleetTierModels } from "./defaultFleetTierModels";

/**
 * Build the Claude-only tier map for `<DelegationChain agents={...}>`.
 *
 * The chain's four tier labels are `fable` (its strong plan/review end),
 * `opus` (smart), `sonnet` (implement), and `haiku` (cheap previews). On an
 * Opus-and-weaker fleet we point the strong end at Opus, so the delegation
 * reads as: Opus plans and reviews, Opus delegates to Opus for smart work and
 * down to Sonnet to implement, with Haiku on previews.
 *
 * Auth is taken from the container env by default (one subscription per
 * container via `CLAUDE_CODE_OAUTH_TOKEN`); pass `token`/`configDir` only to
 * run several subscriptions inside one process.
 */
export function buildFleetTiers(options: BuildFleetTiersOptions = {}) {
  const models = { ...defaultFleetTierModels, ...options.models };
  const auth = options.token
    ? { env: { CLAUDE_CODE_OAUTH_TOKEN: options.token } }
    : options.configDir
      ? { configDir: options.configDir }
      : {};
  const common = {
    ...auth,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    yolo: options.yolo ?? true,
    timeoutMs: options.timeoutMs ?? 75 * 60_000,
    idleTimeoutMs: options.idleTimeoutMs ?? 12 * 60_000,
  };
  const agent = (model: string) => new ClaudeCodeAgent({ ...common, model });
  return {
    fable: [agent(models.strong)],
    opus: [agent(models.smart)],
    sonnet: [agent(models.implement)],
    haiku: [agent(models.cheap)],
  };
}
