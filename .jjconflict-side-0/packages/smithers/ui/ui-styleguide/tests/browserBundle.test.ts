/**
 * The browser half of the package's load promise.
 *
 * `README.md` and `docs/api.md` both say consumers import this package under
 * Node ESM, Bun, and browser bundlers. `tests/nodeEsmResolution.test.ts` proves
 * the first. This proves the third: the barrel bundles for a browser, and
 * nothing in `src/` reaches for a Node built-in or a Node global on the way.
 *
 * The repository-wide gate, `scripts/browser-check.mjs`, reads a declared list
 * in `scripts/browser-contract.mjs` that this package is not on, and both files
 * live outside it. This test is the package's own copy of that promise, run by
 * the target that already owns `src/`, so a Node import added here fails in the
 * package that introduced it rather than two packages downstream.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(packageRoot, "src");

/** Every `.ts` file under `src/`, one level of subdirectory included. */
function sourceFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(directory, entry.name))
      : entry.name.endsWith(".ts")
      ? [join(directory, entry.name)]
      : []
  );
}

describe("the browser bundle", () => {
  test("bundles the barrel for a browser with the tokens intact", () => {
    // `process.execPath` is the Bun that runs this suite, which is also the
    // bundler being asked for. The assertion below proves that, the way
    // `tests/nodeEsmResolution.test.ts` proves the opposite for its child.
    expect(process.versions.bun).toBeDefined();
    const result = spawnSync(process.execPath, ["build", "--target=browser", "src/index.ts"], {
      cwd: packageRoot,
      encoding: "utf8",
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    // The palette selectors are assembled at runtime, so the bundle carries the
    // pieces: the media query, the registry keys, and the font block.
    expect(result.stdout).toContain("prefers-color-scheme: dark");
    expect(result.stdout).toContain("--font-mono:ui-monospace");
    expect(result.stdout).toContain("night-owl");
  }, 120_000);

  // The bundle above cannot catch a Node import. Measured with `node:fs` added
  // to `src/mixColors.ts`: `bun build --target=browser` exits 0, writes nothing
  // to stderr, and leaves no `node:` specifier in the output, because it
  // substitutes a browser shim. Reading the sources is what fails.
  test("keeps Node built-ins and Node globals out of src/", () => {
    const files = sourceFiles(srcDir);
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/from\s+["']node:/);
      expect(source, file).not.toMatch(/\bprocess\.|\brequire\(|\b__dirname\b|\bBuffer\b/);
    }
  });
});
