import type { SubscriptionUsage } from "./SubscriptionUsage";

/**
 * One Claude subscription bound to one rollout container. The fleet runs
 * strictly 1 container : 1 subscription — stacking containers on a sub just
 * races the same pooled quota and the server-side burst limiter.
 *
 * Auth is injected into the container with no smithers code change: set
 * `token` as `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) OR point
 * `configDir` at a `.credentials.json`; `ClaudeCodeAgent` keeps either and
 * strips `ANTHROPIC_API_KEY` so the subscription wins.
 */
export type Subscription = {
  /** Stable id used to key shard assignments and container names. */
  id: string;
  /** Human label (the account label from `~/.smithers/accounts.json`). */
  label?: string;
  /** `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`. */
  token?: string;
  /** Isolated Claude config dir holding this sub's `.credentials.json`. */
  configDir?: string;
  /** Latest rate-limit windows, used to weight shard assignment. */
  usage?: SubscriptionUsage;
};
