import { join } from "node:path";
import { describe, expect, test } from "bun:test";

describe("emitted sandbox service declarations", () => {
  test("preserve the SandboxTransport service-key API", { timeout: 30_000 }, () => {
    const repoRoot = join(import.meta.dir, "../../..");
    const source = join(import.meta.dir, "service-class-consumer-fixture.ts");
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
