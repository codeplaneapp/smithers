import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";

import { bump, expandArtifactPatterns, llmsArtifactPatterns, stageReleasePaths } from "./bump.mjs";

const repoRoot = resolve(import.meta.dirname, "..");

/**
 * Run `fn` with a fake `git` executable fronted on PATH that records its argv
 * NUL-separated, so the exact argument vector (no shell re-parsing) can be
 * asserted.
 *
 * @param {(ctx: { dir: string; env: NodeJS.ProcessEnv; readArgv: () => string[] }) => void} fn
 */
function withFakeGit(fn) {
  const dir = mkdtempSync(join(tmpdir(), "smithers-bump-"));
  const binDir = join(dir, "bin");
  mkdirSync(binDir);
  const captureFile = join(dir, "argv.capture");
  const gitPath = join(binDir, "git");
  writeFileSync(gitPath, `#!/bin/sh\nprintf '%s\\0' "$@" > "${captureFile}"\n`);
  chmodSync(gitPath, 0o755);
  try {
    fn({
      dir,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
      readArgv: () => readFileSync(captureFile, "utf8").split("\0").slice(0, -1),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** @param {(root: string) => void} fn */
function withTempRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), "smithers-bump-root-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** @param {string} root @param {string} file */
function writeFixture(root, file, contents = "") {
  const absFile = join(root, ...file.split("/"));
  mkdirSync(dirname(absFile), { recursive: true });
  writeFileSync(absFile, contents);
}

function writeExecutable(root, name, contents) {
  const path = join(root, "bin", name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${contents}\n`);
  chmodSync(path, 0o755);
}

function createBumpFixture(root) {
  writeFixture(root, "package.json", JSON.stringify({ name: "fixture", version: "2.0.0" }));
  writeFixture(root, "packages/widget/package.json", JSON.stringify({ name: "widget", version: "1.0.0" }));
  writeFixture(root, "apps/demo/package.json", JSON.stringify({ name: "demo", version: "1.0.0" }));
  writeFixture(root, ".smithers/lib/plue-provider.ts", 'export const DEFAULT_ORCHESTRATOR_VERSION = "1.0.0";\n');
  writeFixture(
    root,
    "packages/gateway-client/src/SmithersGatewayClient.ts",
    'const DEFAULT_CLIENT_VERSION = "1.0.0";\n',
  );
  writeFixture(
    root,
    "packages/react-reconciler/src/reconciler.js",
    'const injectedDevToolsConfig = {\n  version: "1.0.0"\n};\n',
  );
  writeFixture(root, "pnpm-lock.yaml", "stale pnpm lock\n");
  writeFixture(root, "bun.lock", "stale bun lock\n");
  for (const artifact of [
    "docs/llms.txt",
    "docs/llms-full.txt",
    "packages/smithers/docs/llms.txt",
    "packages/smithers/docs/llms-full.txt",
    "apps/cli/docs/llms.txt",
    "apps/cli/docs/llms-full.txt",
    "apps/cli/docs/SKILL.md",
    "skills/smithers/llms-full.txt",
  ])
    writeFixture(root, artifact, "artifact\n");
}

function runBumpFixture(root, { bun = true } = {}) {
  const capture = join(root, "stage.argv");
  writeExecutable(root, "git", `printf '%s\\0' "$@" > "${capture}"`);
  writeExecutable(root, "pnpm", `if [ "$1" = install ]; then echo refreshed-pnpm > pnpm-lock.yaml; fi`);
  if (bun) writeExecutable(root, "bun", `if [ "$1" = install ]; then echo refreshed-bun > bun.lock; fi`);
  const env = { ...process.env, PATH: `${join(root, "bin")}:${bun ? process.env.PATH : "/bin"}` };
  bump({ rootDir: root, env });
  return readFileSync(capture, "utf8").split("\0").slice(0, -1);
}

describe("bump", () => {
  test("propagates the version, refreshes both lockfiles, and stages both", () => {
    withTempRoot((root) => {
      createBumpFixture(root);
      const staged = runBumpFixture(root);

      expect(JSON.parse(readFileSync(join(root, "packages/widget/package.json"), "utf8")).version).toBe("2.0.0");
      expect(readFileSync(join(root, "pnpm-lock.yaml"), "utf8")).toBe("refreshed-pnpm\n");
      expect(readFileSync(join(root, "bun.lock"), "utf8")).toBe("refreshed-bun\n");
      expect(staged).toEqual([
        "add",
        "--",
        join(root, "packages/widget/package.json"),
        join(root, "apps/demo/package.json"),
        join(root, ".smithers/lib/plue-provider.ts"),
        join(root, "packages/gateway-client/src/SmithersGatewayClient.ts"),
        join(root, "packages/react-reconciler/src/reconciler.js"),
        join(root, "pnpm-lock.yaml"),
        join(root, "bun.lock"),
        join(root, "docs/llms-full.txt"),
        join(root, "docs/llms.txt"),
        join(root, "packages/smithers/docs/llms-full.txt"),
        join(root, "packages/smithers/docs/llms.txt"),
        join(root, "apps/cli/docs/llms-full.txt"),
        join(root, "apps/cli/docs/llms.txt"),
        join(root, "apps/cli/docs/SKILL.md"),
        join(root, "skills/smithers/llms-full.txt"),
      ]);
    });
  });

  test("reports an actionable error when Bun is unavailable", () => {
    withTempRoot((root) => {
      createBumpFixture(root);
      expect(() => runBumpFixture(root, { bun: false })).toThrow(
        "bump.mjs requires Bun to refresh bun.lock — bun was not found on PATH; install Bun and retry",
      );
      expect(readFileSync(join(root, "bun.lock"), "utf8")).toBe("stale bun lock\n");
    });
  });
});

describe("stageReleasePaths", () => {
  test("passes git an argument vector with a -- separator, no shell evaluation", () => {
    withFakeGit(({ dir, env, readArgv }) => {
      const rootDir = join(dir, "repo");
      mkdirSync(rootDir);
      const pwned = join(dir, "pwned");
      const hostile = [
        join(rootDir, "pkg with space", "package.json"),
        join(rootDir, `it's "quoted"`, "package.json"),
        join(rootDir, "semi;colon.txt"),
        join(rootDir, `back\`touch ${pwned}\`tick.txt`),
        join(rootDir, `$dollar $(touch ${pwned}) \${HOME}.txt`),
      ];

      stageReleasePaths(rootDir, hostile, env);

      expect(readArgv()).toEqual(["add", "--", ...hostile]);
      // A shell-interpolated `git add "…$(touch …)…"` would have created this.
      expect(existsSync(pwned)).toBe(false);
    });
  });

  test("stages everything a version bump needs: changed files, lockfile, expanded artifacts", () => {
    withFakeGit(({ dir, env, readArgv }) => {
      const rootDir = join(dir, "repo");
      writeFixture(rootDir, "docs/llms.txt");
      writeFixture(rootDir, "docs/llms-full.txt");
      writeFixture(rootDir, "docs/llms-v0.1.0.txt");
      writeFixture(rootDir, "skills/smithers/llms-full.txt");
      const changed = [
        join(rootDir, "packages", "with space", "package.json"),
        join(rootDir, ".smithers", "lib", "plue-provider.ts"),
      ];

      const toStage = [
        ...changed,
        join(rootDir, "pnpm-lock.yaml"),
        ...expandArtifactPatterns(rootDir, ["docs/llms*.txt", "skills/smithers/llms-full.txt"]),
      ];
      stageReleasePaths(rootDir, toStage, env);

      expect(readArgv()).toEqual([
        "add",
        "--",
        ...changed,
        join(rootDir, "pnpm-lock.yaml"),
        join(rootDir, "docs", "llms-full.txt"),
        join(rootDir, "docs", "llms-v0.1.0.txt"),
        join(rootDir, "docs", "llms.txt"),
        join(rootDir, "skills", "smithers", "llms-full.txt"),
      ]);
    });
  });
});

describe("expandArtifactPatterns", () => {
  test("expands a final-segment wildcard within its directory only, sorted", () => {
    withTempRoot((root) => {
      writeFixture(root, "docs/llms.txt");
      writeFixture(root, "docs/llms-full.txt");
      writeFixture(root, "docs/other.txt");
      writeFixture(root, "docs/nested/llms-nested.txt");

      expect(expandArtifactPatterns(root, ["docs/llms*.txt"])).toEqual([
        join(root, "docs", "llms-full.txt"),
        join(root, "docs", "llms.txt"),
      ]);
    });
  });

  test("passes literal patterns through untouched", () => {
    withTempRoot((root) => {
      expect(expandArtifactPatterns(root, ["apps/cli/docs/SKILL.md"])).toEqual([
        join(root, "apps", "cli", "docs", "SKILL.md"),
      ]);
    });
  });

  test("throws when a wildcard pattern matches nothing", () => {
    withTempRoot((root) => {
      writeFixture(root, "docs/other.txt");

      expect(() => expandArtifactPatterns(root, ["docs/llms*.txt"])).toThrow(
        'release artifact pattern "docs/llms*.txt" matched no files',
      );
    });
  });

  test("rejects wildcards outside the final path segment", () => {
    withTempRoot((root) => {
      expect(() => expandArtifactPatterns(root, ["docs/*/llms.txt"])).toThrow(
        "a * is only supported in the final path segment",
      );
    });
  });

  test("resolves every release artifact the repository's version bump must stage", () => {
    const paths = expandArtifactPatterns(repoRoot, llmsArtifactPatterns);
    for (const stable of [
      join(repoRoot, "docs", "llms.txt"),
      join(repoRoot, "docs", "llms-full.txt"),
      join(repoRoot, "packages", "smithers", "docs", "llms.txt"),
      join(repoRoot, "packages", "smithers", "docs", "llms-full.txt"),
      join(repoRoot, "apps", "cli", "docs", "llms.txt"),
      join(repoRoot, "apps", "cli", "docs", "llms-full.txt"),
      join(repoRoot, "apps", "cli", "docs", "SKILL.md"),
      join(repoRoot, "skills", "smithers", "llms-full.txt"),
    ]) {
      expect(paths).toContain(stable);
    }
    for (const path of paths) {
      expect(existsSync(path)).toBe(true);
    }
  });
});

describe("bump.mjs module import", () => {
  test("importing the script does not run the bump", () => {
    // The import at the top of this file already executed the module; if the
    // main body had run it would have shelled out to pnpm and mutated the
    // repo. Reaching this assertion with exports intact is the guarantee.
    expect(typeof stageReleasePaths).toBe("function");
    expect(typeof expandArtifactPatterns).toBe("function");
    expect(llmsArtifactPatterns.length).toBeGreaterThan(0);
  });
});
