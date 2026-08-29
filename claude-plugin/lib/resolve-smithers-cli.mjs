// Resolve the Smithers CLI to run, preferring a Smithers *source checkout*
// over any installed copy, and an identified installed copy over a bin-name
// lookup.
//
// Inside the smithers monorepo (this repo, a worktree of it, or any of its
// subdirectories) every internal script must execute
// `packages/cli/bin/smithers.mjs` from the working tree. A package-runner
// invocation does not do that: it downloads and runs the published npm
// tarball, and only lands back on the working tree by accident, via the
// published bin's `node_modules` delegation, which silently does not fire in
// a fresh worktree, a slimmed checkout, or any tree that has not been
// installed. Editing engine code and then watching a run execute last week's
// published build is the failure that mode causes.
//
// Outside a checkout, a bare `smthrs` bin-name lookup is not ours to assume.
// The CLI is published as `@smthrs/cli` and the bin it declares is `smithers`,
// so a runner asked for `smthrs` has to guess, and in any project that ships
// its own `smthrs` bin the runner picks that program instead. That is not
// hypothetical: `@smthrs/build-cli` in this repository declares
// `bin: { smthrs }`, so inside it `bunx smthrs --version` prints that
// package's version and every control subcommand exits COMMAND_NOT_FOUND. The
// plugin monitor died that way. Tier 4 therefore names the package and the bin
// separately: `npx --package @smthrs/cli smithers`.
//
// So resolution walks four tiers, most specific first, and only the last one
// resolves through a package runner:
//
//   1. `workspace`: a Smithers source checkout; run its working tree.
//   2. `installed`: a `node_modules/@smthrs/cli` whose manifest identifies it
//      as the CLI; run the bin path it declares, so no name lookup is
//      involved.
//   3. `path`:      an executable named `smithers` on PATH. That name IS the
//      CLI's own bin, so it is unambiguous in a way `smthrs` is not.
//   4. `published`: `npx --package @smthrs/cli smithers`, the behavior a user
//      with no install gets.
//
// Tiers 1 and 2 spawn `node`, never `bun`: the durable engine is unsupported
// on Bun (rc-contract.md section 1) and `packages/cli/bin/smithers.mjs` pins
// Node in its shebang for the same reason.
//
// Dependency-free (Node built-ins only): this module is copied verbatim into
// every plugin directory that ships standalone. `scripts/check-local-smithers.mjs`
// enforces that the copies stay byte-identical.

import { existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

/** Entry point of the CLI inside a source checkout, relative to the repo root. */
export const SOURCE_CLI_ENTRY = "packages/cli/bin/smithers.mjs";

/** `name` of the monorepo root manifest; the marker that identifies a checkout. */
export const SOURCE_ROOT_PACKAGE_NAME = "smithers";

/** npm package that publishes the Smithers CLI. */
export const PUBLISHED_PACKAGE_NAME = "@smthrs/cli";

/**
 * Bin name the published package declares. Deliberately NOT the package name:
 * a scoped package name is not a bin name at all, and the unscoped `smthrs`
 * belongs to other packages too, while `smithers` does not.
 */
export const PUBLISHED_BIN_NAME = "smithers";

/** Interpreter for a resolved source or installed entry file. */
export const CLI_RUNTIME = "node";

/** Package runner used by the last tier, and the flags that name the package. */
export const PUBLISHED_RUNNER = "npx";

/**
 * True when `directory` is the root of a Smithers source checkout. Both the
 * CLI entry and the root manifest name must match, so an unrelated project
 * that happens to contain `packages/cli/` is never mistaken for one.
 *
 * @param {string} directory
 */
export function isSmithersSourceRoot(directory) {
  if (!existsSync(join(directory, SOURCE_CLI_ENTRY))) return false;
  try {
    const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    return manifest?.name === SOURCE_ROOT_PACKAGE_NAME;
  } catch {
    return false;
  }
}

/**
 * Walk upward from `from` and return the nearest Smithers source checkout root,
 * or null when there is none.
 *
 * @param {string} from
 * @returns {string | null}
 */
export function findSmithersSourceRoot(from) {
  let current = resolve(from);
  while (true) {
    if (isSmithersSourceRoot(current)) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Absolute path of the bin an installed `@smthrs/cli` package declares, or null
 * when `packageDirectory` does not hold the CLI.
 *
 * The manifest `name` must be the published package name: a directory called
 * `node_modules/@smthrs/cli` is not proof, since a workspace may link anything
 * there. `bin` is read as npm defines it: a bare string names the package's
 * single bin, an object is keyed by bin name.
 *
 * @param {string} packageDirectory
 * @returns {string | null}
 */
export function orchestratorBinIn(packageDirectory) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8"));
  } catch {
    return null;
  }
  if (manifest?.name !== PUBLISHED_PACKAGE_NAME) return null;
  const declared = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[PUBLISHED_BIN_NAME];
  if (typeof declared !== "string" || !declared) return null;
  const binPath = resolve(packageDirectory, declared);
  return existsSync(binPath) ? binPath : null;
}

/**
 * Walk upward from `from` looking for an installed Smithers CLI package, and
 * return the absolute path of the bin it declares.
 *
 * @param {string} from
 * @returns {string | null}
 */
export function findInstalledOrchestratorBin(from) {
  let current = resolve(from);
  while (true) {
    const bin = orchestratorBinIn(join(current, "node_modules", ...PUBLISHED_PACKAGE_NAME.split("/")));
    if (bin) return bin;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * File-name candidates for an executable called `name` on this platform.
 * Windows resolves a bare name through PATHEXT; POSIX uses the name as written.
 *
 * @param {string} name
 * @param {NodeJS.ProcessEnv} env
 * @param {string} platform
 * @returns {string[]}
 */
function executableNames(name, env, platform) {
  if (platform !== "win32") return [name];
  const extensions = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.trim())
    .filter(Boolean);
  return [name, ...extensions.map((extension) => `${name}${extension}`)];
}

/**
 * True when `path` is a file this process could execute. The POSIX mode check
 * is advisory: an unreadable stat degrades to "not a candidate" rather than
 * throwing, and Windows carries no execute bit so presence is the whole test.
 *
 * @param {string} path
 * @param {string} platform
 */
function isExecutableFile(path, platform) {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return false;
  }
  if (!stats.isFile()) return false;
  if (platform === "win32") return true;
  return (stats.mode & 0o111) !== 0;
}

/**
 * Absolute path of a Smithers executable on PATH, or null. Unlike a bare
 * bin-name lookup this searches for `smithers`, the name the published
 * package actually declares, so a project-local `smthrs` bin cannot answer
 * for it.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [platform]
 * @returns {string | null}
 */
export function findOrchestratorOnPath(env = process.env, platform = process.platform) {
  const entries = (env.PATH ?? "").split(delimiter).filter(Boolean);
  const names = executableNames(PUBLISHED_BIN_NAME, env, platform);
  for (const entry of entries) {
    // A relative PATH entry is resolved against the cwd, exactly as a shell
    // would; an empty entry was already dropped above.
    const directory = isAbsolute(entry) ? entry : resolve(entry);
    for (const name of names) {
      const candidate = join(directory, name);
      if (isExecutableFile(candidate, platform)) return candidate;
    }
  }
  return null;
}

/**
 * @typedef {object} ResolvedSmithersCli
 * @property {string} command Executable to spawn.
 * @property {string[]} args Leading arguments; append the CLI's own arguments.
 * @property {"workspace" | "installed" | "path" | "published"} source Which copy of Smithers this runs.
 * @property {string | null} root Source checkout root, when one was found.
 */

/**
 * @param {string} [from] Directory to resolve from (defaults to the cwd).
 * @param {NodeJS.ProcessEnv} [env] Environment supplying PATH (defaults to the process env).
 * @returns {ResolvedSmithersCli}
 */
export function resolveSmithersCli(from = process.cwd(), env = process.env) {
  const root = findSmithersSourceRoot(from);
  if (root) {
    return { command: CLI_RUNTIME, args: [join(root, SOURCE_CLI_ENTRY)], source: "workspace", root };
  }
  const installed = findInstalledOrchestratorBin(from);
  if (installed) {
    return { command: CLI_RUNTIME, args: [installed], source: "installed", root: null };
  }
  const onPath = findOrchestratorOnPath(env);
  if (onPath) {
    return { command: onPath, args: [], source: "path", root: null };
  }
  return {
    command: PUBLISHED_RUNNER,
    args: ["--package", PUBLISHED_PACKAGE_NAME, PUBLISHED_BIN_NAME],
    source: "published",
    root: null,
  };
}

/**
 * POSIX-quote a single shell word.
 *
 * @param {string} value
 */
function shellQuote(value) {
  return /^[A-Za-z0-9_\-./:=@]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * The same resolution as {@link resolveSmithersCli}, rendered as a shell
 * command prefix for scripts and agent prompts that build command strings.
 *
 * @param {string} [from]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveSmithersShellCommand(from = process.cwd(), env = process.env) {
  const { command, args } = resolveSmithersCli(from, env);
  return [command, ...args].map(shellQuote).join(" ");
}
