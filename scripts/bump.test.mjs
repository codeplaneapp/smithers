import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";

import { expandArtifactPatterns, llmsArtifactPatterns, stageReleasePaths } from "./bump.mjs";

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
