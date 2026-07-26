import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The engine installs a global Bun.plugin (workflow-module-resolution) whose
// virtual `build.module("react", ...)` registrations leak into every
// in-process Bun.build that passes `plugins`, failing any UI bundle whose
// graph imports react with `onResolve plugin "path" must be absolute when the
// namespace is "file"`. bundleGatewayUiEntry must survive that by retrying the
// build in a clean subprocess. The whole scenario runs in an isolated child
// process so the global plugin never contaminates this shared test process,
// and the child reports through a file because sandboxed local `bun test`
// cannot capture child stdout.
const testsDir = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(testsDir, "..");
const bundleModule = resolve(serverRoot, "src/gatewayUi/bundle.js");
const engineResolutionModule = resolve(serverRoot, "../engine/src/workflow-module-resolution.js");

function runChild(script, outPath) {
  return new Promise((resolveDone) => {
    const env = { ...process.env };
    delete env.SMITHERS_GATEWAY_UI_IN_SUBPROCESS;
    const child = spawn(process.execPath, [script, outPath], {
      cwd: serverRoot,
      env,
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.on("error", () => resolveDone(1));
    child.on("close", (code) => resolveDone(code ?? 1));
  });
}

describe("gateway UI bundling under a poisoned global Bun.plugin", () => {
  let tempDir;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    tempDir = undefined;
  });

  test("bundles a react-importing entry even with the engine's global plugin installed", async () => {
    tempDir = mkdtempSync(join(serverRoot, ".smithers-ui-poison-"));
    const entry = join(tempDir, "entry-react.js");
    writeFileSync(
      entry,
      [
        'import * as React from "react";',
        'export const marker = "POISON_FALLBACK_OK";',
        "console.log(marker, React.version);",
      ].join("\n"),
    );
    const runner = join(tempDir, "runner.js");
    writeFileSync(
      runner,
      [
        `await import(${JSON.stringify(engineResolutionModule)});`,
        `const { bundleGatewayUiEntry } = await import(${JSON.stringify(bundleModule)});`,
        'import { writeFileSync } from "node:fs";',
        "const outPath = process.argv[2];",
        "try {",
        `  const body = await bundleGatewayUiEntry({ entry: ${JSON.stringify(entry)} }, new Map());`,
        '  writeFileSync(outPath, JSON.stringify({ ok: true, hasMarker: body.includes("POISON_FALLBACK_OK"), bytes: body.length }));',
        "} catch (error) {",
        "  writeFileSync(outPath, JSON.stringify({ ok: false, message: String(error && error.message || error) }));",
        "}",
      ].join("\n"),
    );
    const outPath = join(tempDir, "result.json");
    const exitCode = await runChild(runner, outPath);
    expect(existsSync(outPath)).toBe(true);
    const result = JSON.parse(readFileSync(outPath, "utf8"));
    // Holds under both bun behaviors: if the global plugin leaks into
    // Bun.build, the subprocess retry rescues the bundle; if a future bun
    // stops leaking, the in-process build succeeds directly.
    expect(result).toEqual({ ok: true, hasMarker: true, bytes: expect.any(Number) });
    expect(exitCode).toBe(0);
  }, 180_000);
});
