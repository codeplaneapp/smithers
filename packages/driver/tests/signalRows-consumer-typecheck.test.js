import { join } from "node:path";
import { describe, expect, test } from "bun:test";

describe("emitted signalRows declarations", () => {
  test("compile consumer assertions against the published .d.ts", { timeout: 30_000 }, () => {
    const repoRoot = join(import.meta.dir, "../../..");
    const source = join(import.meta.dir, "signalRows-consumer-fixture.ts");
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
    if (result.exitCode !== 0) {
      console.error(result.stdout.toString(), result.stderr.toString());
    }
    expect(result.exitCode).toBe(0);
  });
});
