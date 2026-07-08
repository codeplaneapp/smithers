// Behavioral unit coverage for scripts/check-single-effect-version.mjs
// (SCRIPT_CHECK_SINGLE_EFFECT_VERSION / `pnpm check:effect`). The script
// resolves the repo root from its own location, so each case copies it into a
// throwaway fixture root and drives it against synthetic lockfiles/installs —
// no pnpm, no network, no real workspace.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const realScript = resolve(root, "scripts/check-single-effect-version.mjs");
const created = [];

setDefaultTimeout(30_000);

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function scaffoldFixture() {
  const dir = mkdtempSync(join(tmpdir(), "smithers-effect-gate-"));
  created.push(dir);
  mkdirSync(join(dir, "scripts"), { recursive: true });
  copyFileSync(realScript, join(dir, "scripts", "check-single-effect-version.mjs"));
  return dir;
}

function write(dir, rel, contents) {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf8");
}

function runGate(dir) {
  // The gate runs under `node` in package.json and CI; bun's require
  // resolution can fall back to its global cache and fabricate an installed
  // effect version that node (correctly) never sees.
  return spawnSync("node", [join(dir, "scripts", "check-single-effect-version.mjs")], {
    cwd: dir,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
}

describe("check-single-effect-version gate", () => {
  test("fails loudly when no effect version can be resolved anywhere", () => {
    const dir = scaffoldFixture();
    const result = runGate(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Could not find a resolved effect version");
  });

  test("passes when both lockfiles and every install location agree on one version", () => {
    const dir = scaffoldFixture();
    write(dir, "pnpm-lock.yaml", "packages:\n  effect@3.21.4:\n    resolution: {}\n");
    write(dir, "bun.lock", '{\n  "packages": {\n    "effect": ["effect@3.21.4", {}]\n  }\n}\n');
    write(dir, "node_modules/effect/package.json", JSON.stringify({ name: "effect", version: "3.21.4" }));
    write(
      dir,
      "node_modules/.pnpm/effect@3.21.4/node_modules/effect/package.json",
      JSON.stringify({ name: "effect", version: "3.21.4" }),
    );
    const result = runGate(dir);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("effect version OK: 3.21.4");
  });

  test("reports every divergent version with its sources, sorted, and exits 1", () => {
    const dir = scaffoldFixture();
    write(dir, "pnpm-lock.yaml", "packages:\n  effect@3.21.4:\n    resolution: {}\n");
    write(dir, "node_modules/effect/package.json", JSON.stringify({ name: "effect", version: "3.20.0" }));
    write(
      dir,
      "node_modules/.pnpm/effect@3.20.0/node_modules/effect/package.json",
      JSON.stringify({ name: "effect", version: "3.20.0" }),
    );
    const result = runGate(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Expected exactly one resolved effect version");
    expect(result.stderr).toContain("effect@3.20.0");
    expect(result.stderr).toContain("effect@3.21.4");
    expect(result.stderr).toContain("- pnpm-lock.yaml");
    expect(result.stderr).toContain("- node_modules/effect");
    expect(result.stderr).toContain("- node_modules/.pnpm/effect@3.20.0");
    expect(result.stderr.indexOf("effect@3.20.0")).toBeLessThan(result.stderr.indexOf("effect@3.21.4"));
  });

  test("peer-suffixed and deeper-indented pnpm-lock entries never count as resolved versions", () => {
    const dir = scaffoldFixture();
    write(
      dir,
      "pnpm-lock.yaml",
      [
        "packages:",
        "  effect@3.21.4(react@19.0.0):", // peer-suffixed alias of the same package
        "    resolution: {}",
        "    effect@9.9.9:", // nested / deeper-indented — not a top-level package key
        "  effect@3.21.4:",
        "    resolution: {}",
        "",
      ].join("\n"),
    );
    write(dir, "bun.lock", '{ "packages": { "effect": ["effect@3.21.4", {}] } }\n');
    const result = runGate(dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("effect version OK: 3.21.4");
  });

  test("unreadable installed package metadata is ignored in favor of the lockfiles", () => {
    const dir = scaffoldFixture();
    write(dir, "pnpm-lock.yaml", "packages:\n  effect@3.21.4:\n    resolution: {}\n");
    write(dir, "node_modules/effect/package.json", "{ this is not JSON");
    const result = runGate(dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("effect version OK: 3.21.4");
  });
});
