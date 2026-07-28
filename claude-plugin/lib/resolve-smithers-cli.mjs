// Resolve the Smithers CLI to run, preferring a Smithers *source checkout*
// over any installed copy.
//
// Inside the smithers monorepo (this repo, a worktree of it, or any of its
// subdirectories) every internal script must execute `apps/cli/src/index.js`
// from the working tree. `bunx smithers-orchestrator` does not do that: bunx
// downloads and runs the published npm tarball, and only lands back on the
// working tree by accident, via the published bin's `node_modules` delegation
// — which silently does not fire in a fresh worktree, a slimmed checkout, or
// any tree that has not been installed. Editing engine code and then watching
// a run execute last week's published build is the failure that mode causes.
//
// Outside a checkout there is no source to prefer, so this falls back to
// `bunx smithers-orchestrator` — the behavior every published plugin user gets.
//
// Dependency-free (Node built-ins only): this module is copied verbatim into
// every plugin directory that ships standalone. `scripts/check-local-smithers.mjs`
// enforces that the copies stay byte-identical.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Entry point of the CLI inside a source checkout, relative to the repo root. */
export const SOURCE_CLI_ENTRY = "apps/cli/src/index.js";

/** `name` of the monorepo root manifest; the marker that identifies a checkout. */
export const SOURCE_ROOT_PACKAGE_NAME = "smithers-monorepo";

/**
 * True when `directory` is the root of a Smithers source checkout. Both the
 * CLI entry and the root manifest name must match, so an unrelated project
 * that happens to contain `apps/cli/` is never mistaken for one.
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
 * @typedef {object} ResolvedSmithersCli
 * @property {string} command Executable to spawn.
 * @property {string[]} args Leading arguments; append the CLI's own arguments.
 * @property {"workspace" | "published"} source Which copy of Smithers this runs.
 * @property {string | null} root Source checkout root, when one was found.
 */

/**
 * @param {string} [from] Directory to resolve from (defaults to the cwd).
 * @returns {ResolvedSmithersCli}
 */
export function resolveSmithersCli(from = process.cwd()) {
  const root = findSmithersSourceRoot(from);
  if (root) {
    return { command: "bun", args: [join(root, SOURCE_CLI_ENTRY)], source: "workspace", root };
  }
  return { command: "bunx", args: ["smithers-orchestrator"], source: "published", root: null };
}

/**
 * POSIX-quote a single shell word.
 *
 * @param {string} value
 */
function shellQuote(value) {
  return /^[A-Za-z0-9_\-./:=]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * The same resolution as {@link resolveSmithersCli}, rendered as a shell
 * command prefix for scripts and agent prompts that build command strings.
 *
 * @param {string} [from]
 * @returns {string}
 */
export function resolveSmithersShellCommand(from = process.cwd()) {
  const { command, args } = resolveSmithersCli(from);
  return [command, ...args].map(shellQuote).join(" ");
}
