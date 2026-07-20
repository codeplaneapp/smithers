import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveLaunchRootDir, parsePersistedRootDir } from "../src/resolve-root.js";

/**
 * findSmithersAnchorDir only treats directories strictly below $HOME as project
 * anchors, so the anchor-based tests stage their fixtures under a temporary HOME.
 */
let originalHome;
let home;

beforeEach(() => {
    originalHome = process.env.HOME;
    home = realpathSync(mkdtempSync(join(tmpdir(), "smithers-root-")));
    process.env.HOME = home;
});

afterEach(() => {
    if (originalHome === undefined) {
        delete process.env.HOME;
    }
    else {
        process.env.HOME = originalHome;
    }
    rmSync(home, { recursive: true, force: true });
});

test("explicit --root is resolved against the operator CWD", () => {
    expect(resolveLaunchRootDir("sub/dir", "/a/b")).toBe(resolve("/a/b", "sub/dir"));
    expect(resolveLaunchRootDir("/abs/root", "/a/b")).toBe("/abs/root");
});

test("without --root, anchors to the nearest .smithers/ project root", () => {
    const proj = join(home, "proj");
    mkdirSync(join(proj, ".smithers", "workflows"), { recursive: true });
    const sub = join(proj, "packages", "app");
    mkdirSync(sub, { recursive: true });

    // From the project root and from a nested subdirectory we anchor identically —
    // this is the parity that `up`, `workflow run`, and `graph` all rely on (#283).
    expect(resolveLaunchRootDir(undefined, proj)).toBe(proj);
    expect(resolveLaunchRootDir(undefined, sub)).toBe(proj);
});

test("without an anchor, falls back to the operator CWD (matches DB fallback)", () => {
    const plain = join(home, "no-pack");
    mkdirSync(plain, { recursive: true });
    expect(resolveLaunchRootDir(undefined, plain)).toBe(plain);
});

test("an explicit --root wins even when an anchor exists", () => {
    const proj = join(home, "proj");
    mkdirSync(join(proj, ".smithers"), { recursive: true });
    expect(resolveLaunchRootDir("elsewhere", proj)).toBe(join(proj, "elsewhere"));
});

test("parsePersistedRootDir reads the absolute root from a run config", () => {
    expect(parsePersistedRootDir(JSON.stringify({ rootDir: "/abs/proj", maxConcurrency: 4 }))).toBe("/abs/proj");
});

test("parsePersistedRootDir returns undefined for missing/invalid roots", () => {
    expect(parsePersistedRootDir(null)).toBeUndefined();
    expect(parsePersistedRootDir(undefined)).toBeUndefined();
    expect(parsePersistedRootDir("")).toBeUndefined();
    expect(parsePersistedRootDir("not json")).toBeUndefined();
    expect(parsePersistedRootDir(JSON.stringify({ maxConcurrency: 4 }))).toBeUndefined();
    expect(parsePersistedRootDir(JSON.stringify({ rootDir: "" }))).toBeUndefined();
    expect(parsePersistedRootDir(JSON.stringify({ rootDir: 123 }))).toBeUndefined();
});
