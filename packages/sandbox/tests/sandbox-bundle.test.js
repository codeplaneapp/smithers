import { describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { makeTempDirPath } from "../../testing/src/cleanup/tempDir.ts";
import {
  SANDBOX_MAX_PATCH_FILES,
  SANDBOX_MAX_README_BYTES,
  validateSandboxBundle,
  writeSandboxBundle,
} from "../src/bundle.js";
/**
 * @param {string} prefix
 */
function tempDir(prefix) {
  return makeTempDirPath(prefix);
}
describe("sandbox bundle", () => {
  test("writes and validates a bundle", async () => {
    const bundlePath = tempDir("smithers-sandbox-bundle-");
    const streamLogPath = join(bundlePath, "source-stream.ndjson");
    writeFileSync(streamLogPath, '{"event":"started"}\n', "utf8");
    await writeSandboxBundle({
      bundlePath,
      output: { ok: true },
      status: "finished",
      runId: "child-run-1",
      streamLogPath,
      patches: [
        {
          path: "patches/0001-change.patch",
          content: "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n",
        },
      ],
      artifacts: [
        {
          path: "artifacts/report.json",
          content: '{"ok":true}',
        },
      ],
    });
    const validated = await validateSandboxBundle(bundlePath);
    expect(validated.manifest.status).toBe("finished");
    expect(validated.manifest.outputs).toEqual({ ok: true });
    expect(validated.patchFiles).toContain("patches/0001-change.patch");
    expect(validated.logsPath).toBe(join(bundlePath, "logs", "stream.ndjson"));
  });
  test("round-trips diff bundles in the manifest", async () => {
    const bundlePath = tempDir("smithers-sandbox-bundle-");
    const diffBundle = {
      seq: 7,
      baseRef: "HEAD",
      patches: [
        {
          path: "src/app.ts",
          operation: "modify",
          diff: "diff --git a/src/app.ts b/src/app.ts\n",
        },
      ],
    };
    await writeSandboxBundle({
      bundlePath,
      output: { changed: true },
      status: "finished",
      diffBundle,
    });
    const validated = await validateSandboxBundle(bundlePath);
    expect(validated.manifest.diffBundle).toEqual(diffBundle);
    expect(validated.patchFiles).toEqual([]);
  });
  test("rejects bundle without README", async () => {
    const bundlePath = tempDir("smithers-sandbox-bundle-");
    await expect(validateSandboxBundle(bundlePath)).rejects.toThrow("missing README.md");
  });
  test("rejects README that is not JSON", async () => {
    const bundlePath = tempDir("smithers-sandbox-bundle-");
    writeFileSync(join(bundlePath, "README.md"), "not-json", "utf8");
    await expect(validateSandboxBundle(bundlePath)).rejects.toThrow("must contain valid JSON");
  });
  test("rejects empty README content", async () => {
    const bundlePath = tempDir("smithers-sandbox-bundle-");
    writeFileSync(join(bundlePath, "README.md"), "   \n\t", "utf8");
    await expect(validateSandboxBundle(bundlePath)).rejects.toThrow("README.md is empty");
  });
  test("rejects README JSON that is not an object", async () => {
    const bundlePath = tempDir("smithers-sandbox-bundle-");
    writeFileSync(join(bundlePath, "README.md"), "null", "utf8");
    await expect(validateSandboxBundle(bundlePath)).rejects.toThrow("JSON must be an object");
  });
  test("rejects README with invalid status", async () => {
    const bundlePath = tempDir("smithers-sandbox-bundle-");
    writeFileSync(join(bundlePath, "README.md"), JSON.stringify({ status: "pending" }), "utf8");
    await expect(validateSandboxBundle(bundlePath)).rejects.toThrow("must include status");
  });
  test("rejects manifest patch path traversal", async () => {
    const bundlePath = tempDir("smithers-sandbox-bundle-");
    writeFileSync(
      join(bundlePath, "README.md"),
      JSON.stringify({
        outputs: {},
        status: "finished",
        patches: ["../../etc/passwd"],
      }),
      "utf8",
    );
    await expect(validateSandboxBundle(bundlePath)).rejects.toThrow("escapes sandbox root");
  });
  test("rejects manifest patch path that points at the patches directory", async () => {
    const bundlePath = tempDir("smithers-sandbox-bundle-");
    mkdirSync(join(bundlePath, "patches"), { recursive: true });
    writeFileSync(
      join(bundlePath, "README.md"),
      JSON.stringify({
        outputs: {},
        status: "finished",
        patches: ["patches"],
      }),
      "utf8",
    );
    await expect(validateSandboxBundle(bundlePath)).rejects.toThrow("escapes bundle root");
  });
  test("rejects too many patch files", async () => {
    const bundlePath = tempDir("smithers-sandbox-bundle-");
    mkdirSync(join(bundlePath, "patches"), { recursive: true });
    writeFileSync(join(bundlePath, "README.md"), JSON.stringify({ outputs: {}, status: "finished" }), "utf8");
    for (let i = 0; i <= SANDBOX_MAX_PATCH_FILES; i += 1) {
      writeFileSync(join(bundlePath, "patches", `${String(i).padStart(4, "0")}.patch`), "diff --git a/a b/a\n", "utf8");
    }
    await expect(validateSandboxBundle(bundlePath)).rejects.toThrow("too many patch files");
  });
  test("rejects a symlinked logs stream inside the bundle", async () => {
    const bundlePath = tempDir("smithers-sandbox-bundle-");
    writeFileSync(join(bundlePath, "README.md"), JSON.stringify({ outputs: {}, status: "finished" }), "utf8");
    mkdirSync(join(bundlePath, "logs"), { recursive: true });
    const realTarget = join(bundlePath, "real-stream.ndjson");
    writeFileSync(realTarget, '{"event":"started"}\n', "utf8");
    symlinkSync(realTarget, join(bundlePath, "logs", "stream.ndjson"));
    await expect(validateSandboxBundle(bundlePath)).rejects.toThrow("may not contain symlinks");
  });
  test("rejects a logs stream that becomes a symlink after the bundle walk (TOCTOU re-check)", async () => {
    const bundlePath = tempDir("smithers-sandbox-bundle-");
    writeFileSync(join(bundlePath, "README.md"), JSON.stringify({ outputs: {}, status: "finished" }), "utf8");
    mkdirSync(join(bundlePath, "logs"), { recursive: true });
    const realTarget = join(bundlePath, "real-stream.ndjson");
    writeFileSync(realTarget, '{"event":"started"}\n', "utf8");
    let plantedAt = null;
    const lstatLogs = async (path) => {
      // Simulate a racing writer: the symlink appears only when the
      // final logs lstat runs, after walkFiles already passed.
      symlinkSync(realTarget, path);
      plantedAt = path;
      return lstat(path);
    };
    await expect(validateSandboxBundle(bundlePath, { lstatLogs })).rejects.toThrow("logs may not be a symlink");
    expect(plantedAt).toBe(join(bundlePath, "logs", "stream.ndjson"));
  });
  test("rejects oversized README", async () => {
    const bundlePath = tempDir("smithers-sandbox-bundle-");
    const hugeReadme = "x".repeat(SANDBOX_MAX_README_BYTES + 1);
    writeFileSync(join(bundlePath, "README.md"), hugeReadme, "utf8");
    await expect(validateSandboxBundle(bundlePath)).rejects.toThrow("README.md exceeds");
  });
});
