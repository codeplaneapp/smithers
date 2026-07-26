import { expect, onTestFinished, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const SMITHERS_BIN = resolve(REPO_ROOT, "packages/smithers/src/bin/smithers.js");

/**
 * @param {string} path
 */
function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

/**
 * @param {string} path
 * @param {string} contents
 * @param {number} [mode]
 */
function writeFile(path, contents, mode) {
  ensureDir(dirname(path));
  writeFileSync(path, contents, "utf8");
  if (mode != null) chmodSync(path, mode);
}

/**
 * @param {string} label
 */
function markerScript(label) {
  return [
    "#!/usr/bin/env bun",
    "process.stdout.write(JSON.stringify({",
    `  label: ${JSON.stringify(label)},`,
    "  args: process.argv.slice(2),",
    "  cwd: process.cwd(),",
    '}) + "\\n");',
    "",
  ].join("\n");
}

/**
 * The exact `#!/bin/sh` shim npm/pnpm generate in `node_modules/.bin/`. We
 * write one of these alongside the package so a regression of "exec the shim
 * with `bun`" would crash with the same shell-as-JS parse error users hit.
 */
const POSIX_BIN_SHIM = [
  "#!/bin/sh",
  'basedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")',
  'exec bun "$basedir/../smithers-orchestrator/src/bin/smithers.js" "$@"',
  "",
].join("\n");

/**
 * Install a fake `smithers-orchestrator` package at <root>/node_modules/ whose
 * bin entry prints `label`. Also drops the matching `.bin/smithers` shell shim
 * so the layout matches what npm/pnpm actually produce on disk.
 *
 * @param {string} root
 * @param {string} label
 */
function installFakeSmithersPackage(root, label) {
  const pkgDir = join(root, "node_modules/smithers-orchestrator");
  writeFile(
    join(pkgDir, "package.json"),
    JSON.stringify({
      name: "smithers-orchestrator",
      version: "0.0.0-test",
      bin: { smithers: "./src/bin/smithers.js" },
    }) + "\n",
  );
  writeFile(join(pkgDir, "src/bin/smithers.js"), markerScript(label), 0o755);
  writeFile(join(root, "node_modules/.bin/smithers"), POSIX_BIN_SHIM, 0o755);
}

function createProjectWithLocalBins() {
  const dir = mkdtempSync(join(tmpdir(), "smithers-bin-delegation-"));
  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  writeFile(join(dir, "workflow.tsx"), "export default null;\n");
  writeFile(join(dir, ".smithers/workflows/implement.tsx"), "export default null;\n");
  installFakeSmithersPackage(dir, "root");
  installFakeSmithersPackage(join(dir, ".smithers"), "smithers");
  return dir;
}

/**
 * @param {string} cwd
 * @param {string[]} args
 */
function runBin(cwd, args) {
  const result = spawnSync(process.execPath, [SMITHERS_BIN, ...args], {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`bin failed:\nstdout:${result.stdout}\nstderr:${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

test("bin shim delegates root workflow paths to the root local CLI", () => {
  const cwd = createProjectWithLocalBins();
  const delegated = runBin(cwd, ["up", "workflow.tsx", "--input", "{}"]);

  expect(delegated.label).toBe("root");
  expect(delegated.args).toEqual(["up", "workflow.tsx", "--input", "{}"]);
});

test("bin shim delegates .smithers workflow paths to the .smithers local CLI", () => {
  const cwd = createProjectWithLocalBins();
  const delegated = runBin(cwd, ["up", ".smithers/workflows/implement.tsx"]);

  expect(delegated.label).toBe("smithers");
  expect(delegated.args).toEqual(["up", ".smithers/workflows/implement.tsx"]);
});

test("bin shim keeps workflow-pack commands on the .smithers local CLI", () => {
  const cwd = createProjectWithLocalBins();
  const delegated = runBin(cwd, ["workflow", "run", "implement", "--prompt", "hello"]);

  expect(delegated.label).toBe("smithers");
  expect(delegated.args).toEqual(["workflow", "run", "implement", "--prompt", "hello"]);
});

test("bin shim delegates from a project subdirectory (upward walk)", () => {
  const root = createProjectWithLocalBins();
  const subdir = join(root, "apps", "web", "src");
  ensureDir(subdir);
  const delegated = runBin(subdir, ["ps"]);

  // .smithers/node_modules wins over the project-root node_modules.
  expect(delegated.label).toBe("smithers");
  expect(delegated.args).toEqual(["ps"]);
  // realpath both sides: on macOS tmpdir is /var -> /private/var.
  expect(realpathSync(delegated.cwd)).toBe(realpathSync(subdir));
});

test("bin shim delegates to a project's own node_modules dependency", () => {
  const dir = mkdtempSync(join(tmpdir(), "smithers-bin-delegation-dep-"));
  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  // No .smithers pack at all: the project depends on smithers-orchestrator
  // directly, like a repo using the SDK.
  installFakeSmithersPackage(dir, "project-dep");
  const subdir = join(dir, "src");
  ensureDir(subdir);
  const delegated = runBin(subdir, ["ps"]);

  expect(delegated.label).toBe("project-dep");
  expect(delegated.args).toEqual(["ps"]);
});

test("bin shim ignores a bare .bin/smithers shell shim with no local package (regression)", () => {
  // Reproduces the user-reported crash: `bunx smithers-orchestrator agent --help`
  // found `.smithers/node_modules/.bin/smithers` (a `#!/bin/sh` shim) and tried
  // to re-exec it with `bun`, producing `Expected ")" but found ""$(echo ""`.
  // After the fix we resolve via `node_modules/smithers-orchestrator/package.json`,
  // so a bare `.bin/` shim must NOT trigger delegation.
  const dir = mkdtempSync(join(tmpdir(), "smithers-bin-delegation-shim-"));
  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  writeFile(join(dir, ".smithers/node_modules/.bin/smithers"), POSIX_BIN_SHIM, 0o755);

  const result = spawnSync(process.execPath, [SMITHERS_BIN, "--help"], {
    cwd: dir,
    encoding: "utf8",
  });

  // Pre-fix: bun crashed parsing the shell shim as JS with status 1 and
  // `Expected ")"` on stderr. Post-fix: delegation is skipped, control
  // falls through to the in-process CLI import.
  expect(result.stderr).not.toMatch(/Expected ".*" but found/);
  expect(result.stderr).not.toMatch(/Unexpected case/);
});
