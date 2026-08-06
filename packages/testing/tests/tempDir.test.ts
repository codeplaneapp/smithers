// Regression guard for the $TMPDIR scratch-dir leak: suites created ~30k
// `smithers-*` directories (~35GB) in $TMPDIR and filled the volume twice,
// failing unrelated runs with ENOSPC.
//
// The leak assertions run real suites in a child `bun test` process pointed at
// an isolated $TMPDIR, then assert that directory is empty of `smithers-*`
// entries. Isolating $TMPDIR (rather than counting entries in the shared one)
// is what makes this robust while other test processes run concurrently: no
// other runner can write into a directory this test just created.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupTempDirs, makeTempDir, makeTempDirPath, trackedTempDirs } from "../src/cleanup/tempDir.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * Run `bun test <file>` with $TMPDIR pointed at a directory this test owns and
 * return the `smithers-*` entries the child left behind.
 *
 * The leading `./` matters: without it bun treats the argument as a name
 * filter, silently runs zero tests, and the guard passes vacuously — so the
 * child's reported test count is asserted alongside the leak itself.
 */
const runIsolated = (relativeTestFile: string) => {
  const isolated = makeTempDir("smithers-leakguard-");
  const result = Bun.spawnSync({
    cmd: [process.execPath, "test", `./${relativeTestFile.split(sep).join("/")}`],
    cwd: REPO_ROOT,
    env: { ...process.env, TMPDIR: isolated.path, TMP: isolated.path, TEMP: isolated.path },
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = result.stdout.toString() + result.stderr.toString();
  const ran = Number(/Ran (\d+) tests?/.exec(output)?.[1] ?? 0);
  // The child's own pass/fail is not what is under test here — the leak is.
  const leaked = readdirSync(isolated.path).filter((entry) => entry.startsWith("smithers-"));
  return { ran, leaked, output };
};

describe("makeTempDir", () => {
  test("creates a real directory and tracks it until cleanup", () => {
    const dir = makeTempDir("smithers-unit-");
    expect(existsSync(dir.path)).toBe(true);
    expect(trackedTempDirs()).toContain(dir.path);
    dir.cleanup();
    expect(existsSync(dir.path)).toBe(false);
    expect(trackedTempDirs()).not.toContain(dir.path);
  });

  test("cleanup is idempotent and removes non-empty directories", () => {
    const dir = makeTempDir("smithers-unit-");
    writeFileSync(join(dir.path, "nested.txt"), "contents");
    dir.cleanup();
    dir.cleanup();
    expect(existsSync(dir.path)).toBe(false);
  });

  test("`using` disposes at the end of the block", () => {
    let path = "";
    {
      using dir = makeTempDir("smithers-unit-");
      path = dir.path;
      expect(existsSync(path)).toBe(true);
    }
    expect(existsSync(path)).toBe(false);
  });

  test("cleanupTempDirs drains everything created since the last drain", () => {
    const paths = [makeTempDirPath("smithers-unit-"), makeTempDirPath("smithers-unit-")];
    expect(paths.every(existsSync)).toBe(true);
    cleanupTempDirs();
    expect(paths.some(existsSync)).toBe(false);
    expect(trackedTempDirs()).toEqual([]);
  });
});

describe("$TMPDIR leak guard", () => {
  test("a suite that forgets, throws, and disposes still leaves nothing behind", () => {
    // The fixture covers every way a suite normally leaks. If this fails, the
    // auto-registered afterEach drain (or the process-exit sweep) regressed.
    const { ran, leaked, output } = runIsolated(
      join("packages", "testing", "tests", "fixtures", "tempDirLeakSuite.fixture.ts"),
    );
    expect({ ran: ran > 0, leaked }).toEqual({ ran: true, leaked: [] });
    expect(output).toContain("intentional failure");
  });

  test("a representative real suite leaves nothing behind", () => {
    // sandbox-bundle was one of the observed leaking families
    // (`smithers-sandbox-bundle-`, 52 directories on disk) and is fast enough
    // to run as a guard. A new `mkdtemp` that bypasses makeTempDir fails here.
    const { ran, leaked } = runIsolated(join("packages", "sandbox", "tests", "sandbox-bundle.test.js"));
    expect({ ran: ran > 0, leaked }).toEqual({ ran: true, leaked: [] });
  });
});
