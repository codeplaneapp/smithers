import { describe } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { platform } from "node:process";

const BIN_NAMES = ["zmuxd", "smithers-session-daemon"];

function which(name: string): string | null {
  const result = spawnSync(platform === "win32" ? "where" : "which", [name], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const first = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return first ?? null;
}

/**
 * Resolve the zmuxd daemon binary, in priority order:
 *   1. `SMITHERS_ZMUXD_BIN` env var (exact path).
 *   2. A PATH lookup for `zmuxd` or its `smithers-session-daemon` alias.
 *   3. `../zmux/zig-out/bin/zmuxd` relative to this repo checkout (a
 *      `williamcory/zmux` sibling clone, as CI builds it).
 * Returns null when none resolve, so the zmux e2e suite can skip cleanly on
 * every runner that doesn't have zmux built (see 06-zmux-harness.md).
 */
export function resolveZmuxd(): string | null {
  const fromEnv = process.env.SMITHERS_ZMUXD_BIN;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  for (const name of BIN_NAMES) {
    const resolved = which(name);
    if (resolved && existsSync(resolved)) return resolved;
  }

  const fallback = join(import.meta.dir, "../../../../zmux/zig-out/bin/zmuxd");
  if (existsSync(fallback)) return fallback;

  return null;
}

export const ZMUXD_PATH = resolveZmuxd();

/** zmux is macOS/Linux only (SO_PEERCRED-style peer auth); no Windows build. */
export const ZMUX_UNAVAILABLE = ZMUXD_PATH === null || platform === "win32";

/** `describe.skipIf`-bound suite entry point: every zmux e2e file wraps its tests in this. */
export const describeZmux = describe.skipIf(ZMUX_UNAVAILABLE);
