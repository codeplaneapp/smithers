import { join } from "node:path";
import { describe, expect, test } from "bun:test";

/**
 * Compiles a consumer fixture against the EMITTED src/index.d.ts (resolved
 * through the real @smithers-orchestrator/xstate package exports), following
 * the packages/driver/tests/outputRows-consumer-typecheck.test.js precedent.
 * The tsup dts rollup has dropped generic parameters from alias re-emits
 * before (a non-generic alias applied as generic, TS2315), so the emitted
 * declaration must be consumer-compile-tested, not just generated.
 */
describe("emitted @smithers-orchestrator/xstate declarations", () => {
  test("compile hook, source-helper, and snapshot-surface consumer assertions", { timeout: 60_000 }, () => {
    const repoRoot = join(import.meta.dir, "../../..");
    const source = join(import.meta.dir, "dts-consumer-fixture.ts");
    const tsc = join(repoRoot, "node_modules/typescript/bin/tsc");
    const result = Bun.spawnSync({
      cmd: [
        "node",
        tsc,
        "--ignoreConfig",
        "--noEmit",
        "--strict",
        "--skipLibCheck",
        "--module",
        "ESNext",
        "--moduleResolution",
        "bundler",
        "--target",
        "ESNext",
        source,
      ],
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = `${result.stdout?.toString() ?? ""}${result.stderr?.toString() ?? ""}`;
    expect(output.trim()).toBe("");
    expect(result.exitCode).toBe(0);
  });
});
