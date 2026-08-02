import { existsSync, readFileSync } from "node:fs";
import { dirname, parse, resolve } from "node:path";

const WORKFLOW_PATH_COMMANDS = new Set(["up", "graph", "fork", "replay", "revert", "timetravel"]);
const WORKFLOW_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".mts", ".mdx"]);

/** CLI entry point inside a Smithers source checkout, relative to its root. */
const SOURCE_CLI_ENTRY = "apps/cli/src/index.js";

/** `name` of the monorepo root manifest; the marker that identifies a checkout. */
const SOURCE_ROOT_PACKAGE_NAME = "smithers-monorepo";

/**
 * @param {string} value
 */
export function isOptionLike(value) {
  return value.startsWith("-");
}

/**
 * @param {string} value
 */
export function looksLikeWorkflowPath(value) {
  if (isOptionLike(value)) return false;
  return WORKFLOW_EXTENSIONS.has(parse(value).ext);
}

/**
 * @param {string[]} args
 */
export function getExplicitWorkflowPath(args) {
  if (args.length === 0) return null;
  if (looksLikeWorkflowPath(args[0])) return args[0];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!WORKFLOW_PATH_COMMANDS.has(arg)) continue;
    for (let nextIndex = index + 1; nextIndex < args.length; nextIndex++) {
      const candidate = args[nextIndex];
      if (looksLikeWorkflowPath(candidate)) return candidate;
    }
    return null;
  }
  for (const arg of args) {
    if (looksLikeWorkflowPath(arg)) return arg;
  }
  return null;
}

/**
 * Resolve the local `smthrs` package's bin JS file under
 * `<directory>/node_modules/`. Going through `package.json` (instead of the
 * `.bin/smithers` shell shim npm/pnpm generate) is the whole point: the shim
 * is `#!/bin/sh` and re-execing it with `process.execPath` (bun) makes bun
 * parse shell as JavaScript, which crashes with `Expected ")" but found
 * "$(echo "`.
 *
 * @param {string} directory
 */
export function resolveLocalSmithersBinJs(directory) {
  const pkgJsonPath = resolve(directory, "node_modules/smthrs/package.json");
  if (!existsSync(pkgJsonPath)) return null;
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
  } catch {
    return null;
  }
  const binEntry = typeof pkg?.bin === "string" ? pkg.bin : pkg?.bin?.smithers;
  if (typeof binEntry !== "string" || binEntry.length === 0) return null;
  const binPath = resolve(dirname(pkgJsonPath), binEntry);
  return existsSync(binPath) ? binPath : null;
}

/**
 * Resolve the CLI entry of a Smithers *source checkout* rooted at `directory`,
 * or null when `directory` is not one. Both the entry file and the monorepo
 * manifest name must match, so an unrelated project that happens to contain an
 * `apps/cli/` is never mistaken for one.
 *
 * A checkout outranks every installed copy: someone standing inside the
 * Smithers source tree means *that* Smithers. Without this, editing engine code
 * and running `smithers`/`bunx smthrs` in a tree that has not
 * been installed (a fresh worktree, a slimmed checkout) silently executes the
 * published build instead of the edit under test.
 *
 * @param {string} directory
 */
export function resolveSourceCheckoutCli(directory) {
  const entry = resolve(directory, SOURCE_CLI_ENTRY);
  if (!existsSync(entry)) return null;
  try {
    const manifest = JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8"));
    return manifest?.name === SOURCE_ROOT_PACKAGE_NAME ? entry : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} cwd
 * @param {string} workflowPath
 */
export function findNearestWorkflowLocalCli(cwd, workflowPath) {
  let current = dirname(resolve(cwd, workflowPath));
  while (true) {
    const sourceCli = resolveSourceCheckoutCli(current);
    if (sourceCli) return sourceCli;
    const localBin = resolveLocalSmithersBinJs(current);
    if (localBin) return localBin;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Walk upward from `cwd` and return the nearest project-local smithers bin,
 * the way tsx/bunx resolve the nearest node_modules. At each level a Smithers
 * source checkout wins outright, then the workflow pack's install
 * (`.smithers/node_modules`) wins over the project's own `node_modules`
 * dependency. The walk is unbounded like findLocalPackDir's pack discovery:
 * reaching $HOME and finding `~/.smithers/node_modules` delegates to the global
 * pack's pinned runtime, which is the runtime that serves `~/.smithers`
 * workflows.
 *
 * @param {string} cwd
 */
export function findNearestLocalSmithersCli(cwd) {
  let current = resolve(cwd);
  while (true) {
    const sourceCli = resolveSourceCheckoutCli(current);
    if (sourceCli) return sourceCli;
    const packBin = resolveLocalSmithersBinJs(resolve(current, ".smithers"));
    if (packBin) return packBin;
    const projectBin = resolveLocalSmithersBinJs(current);
    if (projectBin) return projectBin;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Commands that belong to the plugin/CLI protocol rather than to workflow
 * execution, mapped to the release that introduced each one.
 *
 * Delegation exists so workflows run against the runtime the project pinned,
 * but a project pinning an old Smithers also hands it these commands, and an
 * old copy answers with a bare `Unknown command: claude`. That reads as a
 * broken plugin, not as a stale pin, and the Claude Code plugin's background
 * monitor dies with it — so a whole session loses run notifications for a
 * reason nothing on screen explains.
 */
export const PROTOCOL_COMMAND_MIN_VERSION = { claude: "0.27.0" };

/**
 * Leading numeric components of a version string, or null when it does not
 * start with one. Prerelease and build metadata are dropped, so `0.27.0-next.1`
 * compares equal to `0.27.0` — the lenient direction, since a prerelease of the
 * introducing version already carries the command.
 *
 * @param {string} version
 * @returns {number[] | null}
 */
export function parseVersionParts(version) {
  const match = /^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(version);
  if (!match) return null;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {number | null} Negative when a < b, 0 when equal, positive when
 *   a > b; null when either side is unparseable.
 */
export function compareVersions(a, b) {
  const left = parseVersionParts(a);
  const right = parseVersionParts(b);
  if (!left || !right) return null;
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

/**
 * The `smthrs` package that owns `binPath`: its version and the
 * directory whose `package.json` pins it (the parent of `node_modules`). Null
 * when `binPath` is not inside an installed copy, which includes the source
 * checkout entry — a checkout is never a stale pin.
 *
 * @param {string} binPath
 * @returns {{ version: string, packageRoot: string, installRoot: string | null } | null}
 */
export function describeLocalSmithersInstall(binPath) {
  let current = dirname(resolve(binPath));
  while (true) {
    const manifestPath = resolve(current, "package.json");
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        if (manifest?.name === "smthrs" && typeof manifest?.version === "string") {
          const parent = dirname(current);
          const grandparent = dirname(parent);
          const installRoot = parse(parent).base === "node_modules" ? grandparent : null;
          return { version: manifest.version, packageRoot: current, installRoot };
        }
      } catch {
        return null;
      }
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Message for the delegate-to-a-stale-pin trap, or null when delegation can go
 * ahead. Fires only for a protocol command the resolved local copy predates, so
 * an unreadable or new-enough install always delegates as before.
 *
 * @param {object} params
 * @param {string[]} params.args Arguments after the executable.
 * @param {string} params.binPath Local bin delegation resolved to.
 * @returns {string | null}
 */
export function describeProtocolCommandSkew({ args, binPath }) {
  const command = args[0];
  if (!command) return null;
  const required = PROTOCOL_COMMAND_MIN_VERSION[command];
  if (!required) return null;
  const install = describeLocalSmithersInstall(binPath);
  if (!install) return null;
  const ordering = compareVersions(install.version, required);
  if (ordering === null || ordering >= 0) return null;
  const pinnedBy = install.installRoot ? resolve(install.installRoot, "package.json") : install.packageRoot;
  const upgradeIn = install.installRoot ?? install.packageRoot;
  return [
    `[smithers] \`smithers ${command}\` needs smthrs >=${required}, but this directory delegates to ${install.version}.`,
    `[smithers]   pinned by: ${pinnedBy}`,
    `[smithers]   fix: cd ${upgradeIn} && bun add smthrs@latest`,
  ].join("\n");
}
