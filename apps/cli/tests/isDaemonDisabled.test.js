import { expect, onTestFinished, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { isDaemonDisabled } from "../src/isDaemonDisabled.js";

// ---------------------------------------------------------------------------
// Unit: the decision function (spec decision 18).
// ---------------------------------------------------------------------------

test("isDaemonDisabled: enabled by default (no flag, no env)", () => {
  expect(isDaemonDisabled(undefined, {})).toBe(false);
  expect(isDaemonDisabled({}, {})).toBe(false);
  expect(isDaemonDisabled({ daemon: true }, {})).toBe(false);
});

test("isDaemonDisabled: --no-daemon (options.daemon === false) disables, and wins over env", () => {
  expect(isDaemonDisabled({ daemon: false }, {})).toBe(true);
  expect(isDaemonDisabled({ daemon: false }, { SMITHERS_NO_DAEMON: "0" })).toBe(true);
});

test("isDaemonDisabled: truthy SMITHERS_NO_DAEMON values disable (case/space-insensitive)", () => {
  for (const value of ["1", "true", "TRUE", "yes", "Yes", "on", "ON", " 1 ", "  true  "]) {
    expect(isDaemonDisabled(undefined, { SMITHERS_NO_DAEMON: value })).toBe(true);
  }
});

test("isDaemonDisabled: falsy / unset SMITHERS_NO_DAEMON leaves the daemon enabled", () => {
  for (const value of ["", "0", "false", "no", "off", "nope", "   "]) {
    expect(isDaemonDisabled(undefined, { SMITHERS_NO_DAEMON: value })).toBe(false);
  }
  expect(isDaemonDisabled(undefined, {})).toBe(false);
});

test("isDaemonDisabled: env forces disable even when the flag is left at its default true", () => {
  expect(isDaemonDisabled({ daemon: true }, { SMITHERS_NO_DAEMON: "1" })).toBe(true);
});

test("isDaemonDisabled: defaults to process.env when no env arg is given", () => {
  const saved = process.env.SMITHERS_NO_DAEMON;
  try {
    process.env.SMITHERS_NO_DAEMON = "1";
    expect(isDaemonDisabled(undefined)).toBe(true);
    delete process.env.SMITHERS_NO_DAEMON;
    expect(isDaemonDisabled(undefined)).toBe(false);
  } finally {
    if (saved === undefined) delete process.env.SMITHERS_NO_DAEMON;
    else process.env.SMITHERS_NO_DAEMON = saved;
  }
});

// ---------------------------------------------------------------------------
// e2e (no mocks): the real CLI must NOT autostart a gateway daemon when the
// escape hatch is set. A `.smithers` pack dir makes the temp repo resolve as a
// workspace, so `smithers ui` reaches the autostart gate; SMITHERS_NO_DAEMON=1
// must suppress the spawn (no runtime state file) and fail loud with a message
// naming the escape hatch.
// ---------------------------------------------------------------------------

const CLI_ENTRY = resolve(import.meta.dir, "..", "src", "index.js");

test("smithers ui with SMITHERS_NO_DAEMON=1 does not autostart a daemon and fails loud", () => {
  const repo = mkdtempSync(join(tmpdir(), "smithers-nodaemon-e2e-"));
  const stateDir = mkdtempSync(join(tmpdir(), "smithers-nodaemon-state-"));
  onTestFinished(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });
  // A `.smithers` pack dir so resolveGatewayWorkspace() returns this repo.
  mkdirSync(join(repo, ".smithers", "workflows"), { recursive: true });

  // A high, almost-certainly-dead port so the legacy /health probe fails and
  // "reachable" stays false — the autostart gate is then the only way a
  // daemon could appear.
  const result = spawnSync(process.execPath, ["run", CLI_ENTRY, "ui", "--port", "59321"], {
    cwd: repo,
    env: {
      ...process.env,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      SMITHERS_NO_DAEMON: "1",
      SMITHERS_GATEWAY_STATE_DIR: stateDir,
    },
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });

  // No gateway was autostarted: the isolated state dir holds no runtime file.
  const stateFiles = readdirSync(stateDir).filter((name) => name.endsWith(".json"));
  expect(stateFiles).toEqual([]);
  // Failed loud rather than silently spawning or hanging.
  expect(result.status).not.toBe(0);
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  expect(output).toContain("autostart is disabled");
});
