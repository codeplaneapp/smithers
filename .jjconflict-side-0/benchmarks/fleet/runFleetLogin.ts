import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FleetSubscriptionRecord } from "./FleetSubscriptionRecord";
import { fleetAccountConfigDir } from "./fleetAccountConfigDir";
import { fleetManifestPath } from "./fleetManifestPath";

/**
 * Log in to N Claude subscriptions, one isolated config dir each, and record
 * them in the fleet manifest. Interactive: for each account it opens a Claude
 * Code session pinned to that account's `CLAUDE_CONFIG_DIR` with `ANTHROPIC_API_KEY`
 * cleared (so subscription auth is used); you run `/login`, complete the browser
 * auth for THAT account, then `/exit`. Already-logged-in dirs are skipped, so
 * re-running is safe and resumable.
 *
 * The result (config dirs with a refreshable `.credentials.json`) is what the
 * launcher mounts per container, or what `fleet tokens` turns into portable
 * `CLAUDE_CODE_OAUTH_TOKEN`s for Fly per-Machine env.
 */
export function runFleetLogin(opts: { count: number; prefix?: string; claudeBin?: string }): FleetSubscriptionRecord[] {
  const prefix = opts.prefix ?? "fleet";
  const claudeBin = opts.claudeBin ?? process.env.FLEET_CLAUDE ?? "claude";
  const records: FleetSubscriptionRecord[] = [];

  for (let i = 1; i <= opts.count; i++) {
    const label = `${prefix}-${i}`;
    const configDir = fleetAccountConfigDir(label);
    mkdirSync(configDir, { recursive: true });
    const credPath = join(configDir, ".credentials.json");

    if (existsSync(credPath)) {
      console.log(`✓ ${label} already logged in (${configDir})`);
      records.push({ id: label, label, configDir });
      continue;
    }

    console.log(`\n=== Log in to subscription ${i}/${opts.count}: ${label} ===`);
    console.log(`Opening Claude Code pinned to ${configDir}.`);
    console.log(`In it: run /login, complete the browser auth for THIS account, then /exit.\n`);
    spawnSync(claudeBin, [], {
      stdio: "inherit",
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_API_KEY: "" },
    });

    if (!existsSync(credPath)) {
      console.warn(`⚠ ${label}: no credentials written — skipped. Re-run 'fleet login' to retry.`);
      continue;
    }
    records.push({ id: label, label, configDir });
  }

  writeManifest(records);
  console.log(`\nRegistered ${records.length}/${opts.count} subscription(s) → ${fleetManifestPath()}`);
  console.log(`Next: 'fleet tokens' to mint per-Machine CLAUDE_CODE_OAUTH_TOKENs, or mount the config dirs into containers.`);
  return records;
}

function writeManifest(subscriptions: FleetSubscriptionRecord[]): void {
  const path = fleetManifestPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ subscriptions }, null, 2), { mode: 0o600 });
}
