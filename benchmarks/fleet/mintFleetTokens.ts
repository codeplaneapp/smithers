import { spawnSync } from "node:child_process";
import { readFleetSubscriptions } from "./readFleetSubscriptions";

/**
 * Mint a portable `CLAUDE_CODE_OAUTH_TOKEN` for each logged-in subscription, for
 * Fly per-Machine env injection. Runs `claude setup-token` pinned to each
 * account's config dir (interactive: complete the browser auth for that account,
 * the token prints to your terminal). Copy each token into that container's env
 * as `CLAUDE_CODE_OAUTH_TOKEN` with NO `ANTHROPIC_*` set.
 *
 * (Alternative, no tokens: mount each account's config dir into its container as
 * `CLAUDE_CONFIG_DIR` — that carries the refresh token, so the CLI self-refreshes
 * over a multi-day pass.)
 */
export function mintFleetTokens(claudeBin = process.env.FLEET_CLAUDE ?? "claude"): void {
  const subs = readFleetSubscriptions();
  if (subs.length === 0) {
    console.error("No subscriptions registered. Run 'fleet login --count 6' first.");
    process.exit(1);
  }
  console.log(`Minting portable tokens for ${subs.length} subscription(s).`);
  console.log(`For each: complete the browser auth for that account; the token prints below. Map token i -> rollout container i.\n`);
  for (const sub of subs) {
    console.log(`\n=== ${sub.label} (${sub.configDir}) ===`);
    spawnSync(claudeBin, ["setup-token"], {
      stdio: "inherit",
      env: { ...process.env, CLAUDE_CONFIG_DIR: sub.configDir, ANTHROPIC_API_KEY: "" },
    });
  }
  console.log(`\nDone. Inject each token as the matching Machine's CLAUDE_CODE_OAUTH_TOKEN (per-Machine env, not shared 'fly secrets').`);
}
