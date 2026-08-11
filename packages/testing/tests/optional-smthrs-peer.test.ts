import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

describe("optional smthrs peer", () => {
  test("reports how to install smthrs when watch-pack cannot resolve the peer", () => {
    const outDir = mkdtempSync(join(tmpdir(), "smithers-testing-optional-peer-"));
    try {
      const loaderPath = join(outDir, "loadOptionalSmthrs.js");
      copyFileSync(join(import.meta.dir, "../src/loadOptionalSmthrs.js"), loaderPath);
      writeFileSync(join(outDir, "package.json"), '{"type":"module"}\n');

      const result = spawnSync(
        "node",
        [
          "--input-type=module",
          "--eval",
          [
            `const { loadOptionalSmthrs } = await import(${JSON.stringify(pathToFileURL(loaderPath).href)});`,
            "try {",
            '  await loadOptionalSmthrs("Install smthrs to use watch-pack");',
            '  throw new Error("expected the optional peer import to fail");',
            "} catch (error) {",
            "  console.error(error instanceof Error ? error.message : String(error));",
            "  process.exitCode = 42;",
            "}",
          ].join("\n"),
        ],
        { cwd: outDir, encoding: "utf8" },
      );

      expect(result.status).toBe(42);
      expect(result.stderr).toContain("Install smthrs to use watch-pack: `npm install smthrs`");
      expect(result.stderr).toContain('"smthrs" is an optional peerDependency of @smthrs/testing');
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  test("runWorkflowScenario reports the same optional-peer remedy", () => {
    const outDir = mkdtempSync(join(tmpdir(), "smithers-testing-workflow-peer-"));
    try {
      const runnerPath = join(outDir, "runWorkflowScenario.js");
      copyFileSync(join(import.meta.dir, "../src/runWorkflowScenario.js"), runnerPath);
      writeFileSync(join(outDir, "package.json"), '{"type":"module"}\n');

      const result = spawnSync(
        "node",
        [
          "--input-type=module",
          "--eval",
          [
            `const { runWorkflowScenario } = await import(${JSON.stringify(pathToFileURL(runnerPath).href)});`,
            "try {",
            "  await runWorkflowScenario({ workflow: {} });",
            '  throw new Error("expected the optional peer import to fail");',
            "} catch (error) {",
            "  console.error(error instanceof Error ? error.message : String(error));",
            "  process.exitCode = 42;",
            "}",
          ].join("\n"),
        ],
        { cwd: outDir, encoding: "utf8" },
      );

      expect(result.status).toBe(42);
      expect(result.stderr).toContain(
        "Install smthrs to use runWorkflowScenario, or pass runWorkflowFn: `npm install smthrs`",
      );
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
