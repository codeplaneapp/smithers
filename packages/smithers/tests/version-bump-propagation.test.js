// Behavioral unit coverage for scripts/bump.mjs (the `pnpm version` lifecycle
// hook behind NPM_SCRIPT_RELEASE): workspace version propagation and the two
// drift guards that must refuse a release when the pinned-version regexes stop
// matching their source files. Both guards throw BEFORE the script reaches
// `pnpm install`/`docs:llms`/`git add`, so every case here stays offline and
// never spawns a package manager — the fixtures deliberately break a guard to
// stop execution right after the pure file rewrites we want to observe.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const realScript = resolve(root, "scripts/bump.mjs");
const created = [];

setDefaultTimeout(30_000);

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function write(dir, rel, contents) {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof contents === "string" ? contents : `${JSON.stringify(contents, null, 2)}\n`, "utf8");
}

function scaffoldFixture() {
  const dir = mkdtempSync(join(tmpdir(), "smithers-bump-fixture-"));
  created.push(dir);
  mkdirSync(join(dir, "scripts"), { recursive: true });
  copyFileSync(realScript, join(dir, "scripts", "bump.mjs"));
  write(dir, "package.json", { name: "fixture-root", version: "9.9.9" });
  write(dir, "packages/pub-a/package.json", { name: "@fixture/pub-a", version: "1.0.0" });
  write(dir, "packages/priv/package.json", { name: "@fixture/priv", private: true, version: "1.0.0" });
  write(dir, "packages/same/package.json", { name: "@fixture/same", version: "9.9.9" });
  write(dir, "packages/broken-manifest/package.json", "{ not json");
  write(dir, "apps/app-pub/package.json", { name: "@fixture/app-pub", version: "0.1.0" });
  return dir;
}

function runBump(dir) {
  return spawnSync(process.execPath, [join(dir, "scripts", "bump.mjs")], {
    cwd: dir,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
}

const readJson = (dir, rel) => JSON.parse(readFileSync(join(dir, rel), "utf8"));

describe("bump.mjs version propagation and drift guards", () => {
  test("propagates only to non-private, out-of-date packages, then refuses when the provider pin no longer matches", () => {
    const dir = scaffoldFixture();
    write(dir, ".smithers/lib/plue-provider.ts", "export const SOMETHING_ELSE = 1;\n");
    const result = runBump(dir);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("could not sync DEFAULT_ORCHESTRATOR_VERSION");
    expect(result.stderr).toContain("update the regex in scripts/bump.mjs");

    // Propagation happens before the guard: exactly the two stale public
    // packages were rewritten, private/current/unparseable ones untouched.
    expect(result.stdout).toContain("bumped 2 workspace package(s)");
    expect(readJson(dir, "packages/pub-a/package.json").version).toBe("9.9.9");
    expect(readJson(dir, "apps/app-pub/package.json").version).toBe("9.9.9");
    expect(readJson(dir, "packages/priv/package.json").version).toBe("1.0.0");
    expect(readFileSync(join(dir, "packages/broken-manifest/package.json"), "utf8")).toBe("{ not json");
  });

  test("syncs the provider pin on disk, then refuses when the gateway-client pin no longer matches", () => {
    const dir = scaffoldFixture();
    write(dir, ".smithers/lib/plue-provider.ts", 'export const DEFAULT_ORCHESTRATOR_VERSION = "0.0.1";\n');
    write(dir, "packages/gateway-client/src/SmithersGatewayClient.ts", "const noPinHere = true;\n");
    const result = runBump(dir);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("could not sync DEFAULT_CLIENT_VERSION");

    const provider = readFileSync(join(dir, ".smithers/lib/plue-provider.ts"), "utf8");
    expect(provider).toContain('DEFAULT_ORCHESTRATOR_VERSION = "9.9.9"');
    expect(provider).not.toContain('"0.0.1"');
  });

  test("an already-synced provider pin is left byte-identical instead of being rewritten", () => {
    const dir = scaffoldFixture();
    const pinned = 'export const DEFAULT_ORCHESTRATOR_VERSION = "9.9.9";\n';
    write(dir, ".smithers/lib/plue-provider.ts", pinned);
    write(dir, "packages/gateway-client/src/SmithersGatewayClient.ts", "const noPinHere = true;\n");
    const result = runBump(dir);

    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("synced DEFAULT_ORCHESTRATOR_VERSION");
    expect(readFileSync(join(dir, ".smithers/lib/plue-provider.ts"), "utf8")).toBe(pinned);
  });
});
