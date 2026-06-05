import type { AccountProvider } from "@smithers-orchestrator/accounts";
import type { UsageSource } from "./UsageSource";
import type { UsageWindow } from "./UsageWindow";

/**
 * Normalized usage for a single registered account. Every adapter — subscription
 * utilization, API-key headers, local estimate — produces this same shape so the
 * CLI, gateway, and UI render one model.
 */
export type UsageReport = {
  /** The account's label in `~/.smithers/accounts.json`. */
  accountLabel: string;
  /** The account's provider. */
  provider: AccountProvider;
  /** How this account authenticates. */
  authMode: "subscription" | "api-key";
  /** Where the numbers came from. */
  source: UsageSource;
  /** Quota windows, possibly empty when `source` is `none`. */
  windows: UsageWindow[];
  /** Plan/tier label if the provider reports one, e.g. "max", "pro". */
  planType?: string;
  /** Pay-as-you-go credit balance, if the provider reports one (Codex). */
  credits?: { hasCredits: boolean; unlimited: boolean; balance?: string };
  /** ISO-8601 timestamp of when this report was produced. */
  fetchedAt: string;
  /** True when served from cache past its soft TTL. */
  stale: boolean;
  /** True when the windows are locally estimated, not provider-authoritative. */
  estimate: boolean;
  /** Human-readable reason when `source` is `none` or a probe failed. */
  error?: string;
};
