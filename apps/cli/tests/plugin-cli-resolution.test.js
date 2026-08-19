import { expect, onTestFinished, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findOrchestratorOnPath,
  orchestratorBinIn,
  PUBLISHED_BIN_NAME,
  PUBLISHED_PACKAGE_NAME,
  resolveSmithersCli,
  SOURCE_CLI_ENTRY,
  SOURCE_ROOT_PACKAGE_NAME,
} from "../../../claude-plugin/lib/resolve-smithers-cli.mjs";

// The plugin resolver decides WHICH copy of Smithers every plugin surface runs.
// Getting it wrong is silent: the plugin launches a different program that
// prints its own help and exits 0, so the mirror cannot tell a broken CLI from
// an empty tick. The case that actually shipped: `bunx smthrs` is a bin-NAME
// lookup, and `@smthrs/build-cli` (in the flows repo) declares a `smthrs` bin,
// so inside flows the plugin ran that build tool and every orchestrator
// subcommand exited COMMAND_NOT_FOUND. These tests pin each resolution tier and
// that regression.

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");

/** @param {string} label */
function tempDir(label) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `smithers-cli-resolution-${label}-`)));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * @param {string} path
 * @param {string} contents
 * @param {number} [mode]
 */
function writeFile(path, contents, mode) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf8");
  if (mode != null) chmodSync(path, mode);
}

/**
 * A project directory carrying an installed package at
 * `node_modules/<packageDir>` with the given manifest, plus the bin file it
 * declares.
 *
 * @param {string} label
 * @param {{ packageDir?: string, name: string, bin?: unknown, writeBinFile?: boolean }} options
 */
function projectWithInstalledPackage(label, { packageDir = PUBLISHED_PACKAGE_NAME, name, bin, writeBinFile = true }) {
  const project = tempDir(label);
  const installed = join(project, "node_modules", packageDir);
  writeFile(join(installed, "package.json"), JSON.stringify({ name, version: "9.9.9", bin }));
  if (writeBinFile && typeof bin === "object" && bin !== null) {
    for (const relative of Object.values(/** @type {Record<string, string>} */ (bin))) {
      writeFile(join(installed, relative), "#!/usr/bin/env node\n");
    }
  }
  if (writeBinFile && typeof bin === "string") writeFile(join(installed, bin), "#!/usr/bin/env node\n");
  return { project, installed };
}

/** An env whose PATH holds nothing, so the `path` tier can never match. */
const NO_PATH = { PATH: "" };

test("a source checkout runs the working tree, not any installed copy", () => {
  const root = tempDir("workspace");
  writeFile(join(root, SOURCE_CLI_ENTRY), "// entry\n");
  writeFile(join(root, "package.json"), JSON.stringify({ name: SOURCE_ROOT_PACKAGE_NAME }));
  const nested = join(root, "packages", "deep");
  mkdirSync(nested, { recursive: true });

  const resolved = resolveSmithersCli(nested, NO_PATH);

  expect(resolved.source).toBe("workspace");
  expect(resolved.root).toBe(root);
  expect(resolved.args[0]).toBe(join(root, SOURCE_CLI_ENTRY));
});

test("an installed orchestrator package runs the bin path its manifest declares", () => {
  const { project, installed } = projectWithInstalledPackage("installed", {
    name: PUBLISHED_PACKAGE_NAME,
    bin: { [PUBLISHED_BIN_NAME]: "./src/bin/smithers.js" },
  });

  const resolved = resolveSmithersCli(project, NO_PATH);

  expect(resolved.source).toBe("installed");
  expect(resolved.args).toEqual([join(installed, "src/bin/smithers.js")]);
});

test("an installed package is found from a nested working directory", () => {
  const { project, installed } = projectWithInstalledPackage("installed-nested", {
    name: PUBLISHED_PACKAGE_NAME,
    bin: { [PUBLISHED_BIN_NAME]: "./src/bin/smithers.js" },
  });
  const nested = join(project, "apps", "web", "src");
  mkdirSync(nested, { recursive: true });

  const resolved = resolveSmithersCli(nested, NO_PATH);

  expect(resolved.source).toBe("installed");
  expect(resolved.args).toEqual([join(installed, "src/bin/smithers.js")]);
});

test("a node_modules/smthrs directory holding a DIFFERENT package is not the orchestrator", () => {
  // A workspace can link anything to that path, so the directory name is not
  // proof of identity; the manifest `name` is.
  const { project } = projectWithInstalledPackage("impostor", {
    name: "@someone/unrelated",
    bin: { [PUBLISHED_BIN_NAME]: "./cli.js" },
  });

  const resolved = resolveSmithersCli(project, NO_PATH);

  expect(resolved.source).toBe("published");
});

test("an installed manifest declaring no smithers bin is not the orchestrator", () => {
  const { project } = projectWithInstalledPackage("no-bin", {
    name: PUBLISHED_PACKAGE_NAME,
    bin: { somethingElse: "./cli.js" },
  });

  expect(resolveSmithersCli(project, NO_PATH).source).toBe("published");
});

test("an installed manifest whose declared bin file is missing is not the orchestrator", () => {
  const { project } = projectWithInstalledPackage("missing-bin-file", {
    name: PUBLISHED_PACKAGE_NAME,
    bin: { [PUBLISHED_BIN_NAME]: "./src/bin/smithers.js" },
    writeBinFile: false,
  });

  expect(resolveSmithersCli(project, NO_PATH).source).toBe("published");
});

test("orchestratorBinIn returns null for a missing or malformed manifest", () => {
  const dir = tempDir("malformed");
  expect(orchestratorBinIn(join(dir, "absent"))).toBeNull();
  writeFile(join(dir, "broken", "package.json"), "{ not json");
  expect(orchestratorBinIn(join(dir, "broken"))).toBeNull();
});

test("an executable named smithers on PATH is preferred over the published fallback", () => {
  const project = tempDir("on-path");
  const binDir = tempDir("path-entry");
  const executable = join(binDir, PUBLISHED_BIN_NAME);
  writeFile(executable, "#!/bin/sh\n", 0o755);

  const resolved = resolveSmithersCli(project, { PATH: [join(binDir, "absent"), binDir].join(delimiter) });

  expect(resolved.source).toBe("path");
  expect(resolved.command).toBe(executable);
  expect(resolved.args).toEqual([]);
});

test("a non-executable file named smithers on PATH is not a candidate", () => {
  const project = tempDir("path-not-exec");
  const binDir = tempDir("path-entry-not-exec");
  writeFile(join(binDir, PUBLISHED_BIN_NAME), "not executable\n", 0o644);

  // POSIX only: Windows carries no execute bit, so presence is the whole test.
  if (process.platform !== "win32") {
    expect(findOrchestratorOnPath({ PATH: binDir })).toBeNull();
    expect(resolveSmithersCli(project, { PATH: binDir }).source).toBe("published");
  }
});

test("a directory named smithers on PATH is not mistaken for the executable", () => {
  const binDir = tempDir("path-entry-dir");
  mkdirSync(join(binDir, PUBLISHED_BIN_NAME), { recursive: true });

  expect(findOrchestratorOnPath({ PATH: binDir })).toBeNull();
});

test("with nothing installed and nothing on PATH, the published fallback is used", () => {
  const resolved = resolveSmithersCli(tempDir("published"), NO_PATH);

  expect(resolved).toEqual({
    command: "bunx",
    args: [PUBLISHED_PACKAGE_NAME],
    source: "published",
    root: null,
  });
});

test("REGRESSION: a foreign package's `smthrs` bin never answers for the orchestrator", () => {
  // The flows repo ships `@smthrs/build-cli` with `bin: { smthrs }`. `bunx
  // smthrs` resolves by bin name and picks it, so the plugin ran a build tool
  // that printed its own help and exited 0. Resolution must ignore that bin
  // entirely: with no real orchestrator anywhere it falls through to the
  // published package, and it must never name the foreign binary.
  const project = tempDir("foreign-bin");
  const foreign = join(project, "node_modules", ".bin", "smthrs");
  writeFile(foreign, "#!/bin/sh\necho 'flows build cli'\n", 0o755);
  writeFile(
    join(project, "node_modules", "@smthrs", "build-cli", "package.json"),
    JSON.stringify({ name: "@smthrs/build-cli", version: "0.1.0", bin: { smthrs: "./src/main.js" } }),
  );

  const resolved = resolveSmithersCli(project, NO_PATH);

  expect(resolved.source).toBe("published");
  expect(resolved.command).not.toBe(foreign);
  expect(resolved.args).not.toContain(foreign);
});

test("the SessionStart hook's mirror-default constant matches the mirror script's fallback", () => {
  // The mirror is a sandboxed Workflow script and cannot import the constant,
  // so the two literals are coupled by this assertion. If they drift, the hook
  // stops naming a CLI it should name (or names one it need not).
  const hook = readFileSync(resolve(REPO_ROOT, "claude-plugin/hooks/session-start.mjs"), "utf8");
  const mirror = readFileSync(resolve(REPO_ROOT, "claude-plugin/workflows/smithers-run.mjs"), "utf8");

  const hookDefault = hook.match(/const MIRROR_DEFAULT_CLI = "([^"]+)"/)?.[1];
  const mirrorDefault = mirror.match(/workflowArgs\.cli\.trim\(\)\s*\n\s*:\s*'([^']+)'/)?.[1];

  expect(hookDefault).toBeTruthy();
  expect(mirrorDefault).toBeTruthy();
  expect(hookDefault).toBe(mirrorDefault);
});

test("both plugin trees ship the identical resolver", () => {
  const claude = readFileSync(resolve(REPO_ROOT, "claude-plugin/lib/resolve-smithers-cli.mjs"), "utf8");
  const codex = readFileSync(resolve(REPO_ROOT, "codex-plugin/lib/resolve-smithers-cli.mjs"), "utf8");

  expect(codex).toBe(claude);
});

/**
 * Run the SessionStart hook with a controlled cwd and PATH, and return the
 * context it injects.
 *
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
function runSessionStartHook(cwd, env) {
  const result = spawnSync(process.execPath, [resolve(REPO_ROOT, "claude-plugin/hooks/session-start.mjs")], {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...env, CLAUDE_PLUGIN_ROOT: resolve(REPO_ROOT, "claude-plugin") },
  });
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout ?? "{}")?.hookSpecificOutput?.additionalContext ?? "";
}

/**
 * A minimal `.smithers/` project, the only shape the hook injects context for.
 *
 * @param {string} label
 */
function smithersProject(label) {
  const project = tempDir(label);
  mkdirSync(join(project, ".smithers", "workflows"), { recursive: true });
  return project;
}

test("the hook names the resolved CLI for the mirror outside a source checkout", () => {
  // The user-visible defect: outside a Smithers checkout the hook passed no
  // `cli`, so the mirror fell back to `bunx smthrs` and ran whichever program
  // owned that bin name. A project with an identified orchestrator must get it
  // named explicitly.
  const project = smithersProject("hook-names-cli");
  const binDir = tempDir("hook-path-entry");
  const executable = join(binDir, PUBLISHED_BIN_NAME);
  writeFile(executable, "#!/bin/sh\necho '{\"runs\":[]}'\n", 0o755);

  const context = runSessionStartHook(project, { PATH: binDir });

  expect(context).toContain("LIVE VIEW RULE");
  expect(context).toContain(`cli: ${JSON.stringify(executable)}`);
  expect(context).not.toContain("SOURCE-CHECKOUT RULE");
});

test("the hook stays silent about the CLI when resolution equals the mirror's own default", () => {
  const project = smithersProject("hook-default-cli");

  const context = runSessionStartHook(project, { PATH: "" });

  expect(context).toContain("LIVE VIEW RULE");
  expect(context).not.toContain("cli: ");
});
