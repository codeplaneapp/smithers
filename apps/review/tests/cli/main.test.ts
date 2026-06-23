import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const MAIN_TS = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const PKG_ROOT = fileURLToPath(new URL("../../", import.meta.url));

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function spawnMain(args: string[], env?: Record<string, string>): SpawnResult {
  const result = Bun.spawnSync(["bun", MAIN_TS, ...args], {
    cwd: PKG_ROOT,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode ?? 1,
  };
}

describe("main (CLI entrypoint, subprocess)", () => {
  test("--help prints USAGE and exits 0", () => {
    const result = spawnMain(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("smithers review");
    expect(result.stdout).toContain("Usage: smithers-review");
    expect(result.stdout).toContain("--help");
  });

  test("-h prints USAGE and exits 0", () => {
    const result = spawnMain(["-h"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("smithers review");
    expect(result.stdout).toContain("Usage: smithers-review");
  });

  test("unknown option exits 1 and prints error + USAGE to stderr", () => {
    const result = spawnMain(["--totally-unknown-flag-xyz"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("smithers-review:");
    expect(result.stderr).toContain("Unknown option");
    expect(result.stderr).toContain("Usage: smithers-review");
  });

  test("option missing value exits 1 and prints error + USAGE to stderr", () => {
    const result = spawnMain(["--from"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("smithers-review:");
    expect(result.stderr).toContain("--from requires a value");
    expect(result.stderr).toContain("Usage: smithers-review");
  });
});
