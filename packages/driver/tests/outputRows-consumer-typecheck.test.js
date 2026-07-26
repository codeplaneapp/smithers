import { join } from "node:path";
import { describe, expect, test } from "bun:test";

describe("emitted outputRows declarations", () => {
  test("compile schema-derived positive and negative consumer assertions", { timeout: 30_000 }, () => {
    const repoRoot = join(import.meta.dir, "../../..");
    const source = join(import.meta.dir, "outputRows-consumer-fixture.ts");
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
    expect(result.exitCode).toBe(0);
  });
});
