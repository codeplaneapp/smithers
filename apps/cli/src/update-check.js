import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";

import { SOTA_REGISTRY_VERSION } from "./sota-models.generated.js";

/**
 * Update detection + a once-a-day "new version available" notice.
 *
 * Two surfaces are built on the helpers here:
 *  1. `smithers update` — detects how the binary was installed and either runs
 *     the right upgrade command or prints it (see {@link buildUpdatePlan}).
 *  2. The passive notice wired into the CLI's main loop, which checks npm at
 *     most once per day and tells the user when a newer version is published
 *     (see {@link ensureUpdateCheck} + {@link formatUpdateNotice}).
 *
 * The same daily budget also fetches the SOTA model registry version from the
 * repo (docs/data/sota-models.json). When a newer release ships with a newer
 * registry, the notice additionally tells the user that new SOTA models are in
 * and to re-run `smithers init` so installed workflows pick up the new agents.
 *
 * Everything is best-effort: a missing network, a malformed marker, or an
 * unparseable version must never break a real command, so the public entry
 * points swallow their own errors and degrade to "no notice".
 */

/** The published npm package. The `smithers` binary is only an alias of it. */
export const SMITHERS_PACKAGE = "smithers-orchestrator";

/** Throttle window for the passive npm check. */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Where the current SOTA model registry lives. `main` is ahead of releases,
 * which is fine: the notice only fires once a release carrying the newer
 * registry exists (see {@link formatUpdateNotice}). */
export const SOTA_REGISTRY_URL =
  "https://raw.githubusercontent.com/smithersai/smithers/main/docs/data/sota-models.json";

/** The docs sidebar is the authoritative published changelog index. */
export const CHANGELOG_INDEX_URL = "https://raw.githubusercontent.com/smithersai/smithers/main/docs/docs.json";

/** Raw GitHub URL prefix for published changelog MDX files. */
export const CHANGELOG_RAW_BASE_URL = "https://raw.githubusercontent.com/smithersai/smithers/main/docs/changelogs";

/** Default network timeout for the registry probe. Kept short so the one
 * throttled check a day never noticeably stalls a command. */
const DEFAULT_FETCH_TIMEOUT_MS = 1500;

const DEFAULT_CHANGELOG_MAX_ENTRIES = 20;
const DEFAULT_CHANGELOG_MAX_CHARS = 12_000;

/**
 * Read this installed CLI package's version.
 *
 * @returns {string}
 */
export function readCurrentPackageVersion() {
  try {
    const pkgUrl = new URL("../package.json", import.meta.url);
    const raw = readFileSync(pkgUrl, "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Parse a version string into comparable numeric release components, dropping
 * any pre-release / build metadata. `"v0.26.1-beta.2+sha"` → `[0, 26, 1]`.
 *
 * @param {string} version
 * @returns {number[] | null} release numbers, or null when unparseable
 */
export function parseVersion(version) {
  if (typeof version !== "string") return null;
  const trimmed = version.trim().replace(/^v/i, "");
  const release = trimmed.split(/[-+]/, 1)[0];
  if (!release) return null;
  const parts = release.split(".");
  const nums = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    nums.push(Number.parseInt(part, 10));
  }
  return nums.length > 0 ? nums : null;
}

/**
 * Compare two release versions ignoring pre-release tags. A pre-release of the
 * same release (e.g. `1.2.0-rc.1`) is treated as equal to its release for the
 * purposes of "is there something newer" — we only nudge on a higher release.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} negative if a < b, 0 if equal/uncomparable, positive if a > b
 */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * @param {string} latest
 * @param {string} current
 * @returns {boolean} true when `latest` is a strictly newer release
 */
export function isUpdateAvailable(latest, current) {
  return compareVersions(latest, current) > 0;
}

/**
 * Decide how Smithers was installed by inspecting the resolved path of the
 * running binary. This drives the upgrade command we recommend or run.
 *
 * The kinds:
 *  - `bunx` / `npx`     — a transient cache run; there is nothing to upgrade,
 *                          re-running with `@latest` already fetches the newest.
 *  - `global`           — a global install (bun/npm/pnpm/yarn); upgradeable.
 *  - `local`            — a project `node_modules` install; bump the dependency.
 *  - `unknown`          — fall back to a sensible default command.
 *
 * @param {{ execPath?: string; env?: NodeJS.ProcessEnv; runtimeIsBun?: boolean }} [opts]
 * @returns {{ kind: "bunx" | "global" | "local" | "unknown"; manager: "bun" | "npm" | "pnpm" | "yarn"; path: string }}
 */
export function detectInstallMethod(opts = {}) {
  const env = opts.env ?? process.env;
  const runtimeIsBun = opts.runtimeIsBun ?? typeof process.versions?.bun === "string";
  // The binary path is the strongest signal we have. Normalise separators so
  // the substring checks work the same on Windows.
  const rawPath = opts.execPath ?? process.argv?.[1] ?? "";
  const path = rawPath.split(sep).join("/");
  const lower = path.toLowerCase();

  const has = (needle) => lower.includes(needle);

  // Transient one-off runners (`bunx`, `npx`). These live in throwaway caches,
  // so "updating" them is a no-op — the next `@latest` run is the update.
  if (has("/install/cache/") || has("/.bun/install/cache")) {
    return { kind: "bunx", manager: "bun", path };
  }
  if (has("/_npx/") || has("/npm-cache/_npx")) {
    return { kind: "bunx", manager: "npm", path };
  }

  // Global installs, keyed by the package manager's well-known global prefix.
  if (has("/.bun/bin") || has("/.bun/install/global")) {
    return { kind: "global", manager: "bun", path };
  }
  if (has("/pnpm/") || has("/.local/share/pnpm") || has("/library/pnpm")) {
    return { kind: "global", manager: "pnpm", path };
  }
  if (has("/.yarn/") || has("/yarn/global") || has("/.config/yarn/global")) {
    return { kind: "global", manager: "yarn", path };
  }
  if (has("/lib/node_modules/") || has("/.npm-global/") || has("/.npm-packages/") || has("/.nvm/versions/node/")) {
    return { kind: "global", manager: "npm", path };
  }

  // A project-local install: the binary is a `node_modules/.bin` shim that is
  // not in any of the global/cache locations handled above.
  if (has("/node_modules/.bin") || has("/node_modules/")) {
    return { kind: "local", manager: runtimeIsBun ? "bun" : "npm", path };
  }

  return { kind: "unknown", manager: runtimeIsBun ? "bun" : "npm", path };
}

/**
 * The exact shell command that upgrades a global install for `manager`.
 *
 * @param {"bun" | "npm" | "pnpm" | "yarn"} manager
 * @param {string} [pkg]
 * @returns {string}
 */
export function globalUpdateCommand(manager, pkg = SMITHERS_PACKAGE) {
  switch (manager) {
    case "bun":
      return `bun add -g ${pkg}@latest`;
    case "pnpm":
      return `pnpm add -g ${pkg}@latest`;
    case "yarn":
      return `yarn global add ${pkg}@latest`;
    default:
      return `npm install -g ${pkg}@latest`;
  }
}

/**
 * Turn a detected install into an actionable plan: a one-line explanation, the
 * command to run (when one applies), and whether the CLI can run it for the
 * user. `bunx`/`npx` runs are not upgradeable in place — the plan tells the
 * user the next `@latest` invocation already is the update.
 *
 * @param {ReturnType<typeof detectInstallMethod>} install
 * @param {string} [pkg]
 * @returns {{ runnable: boolean; command: string | null; explanation: string }}
 */
export function buildUpdatePlan(install, pkg = SMITHERS_PACKAGE) {
  switch (install.kind) {
    case "bunx":
      return {
        runnable: false,
        command: null,
        explanation:
          install.manager === "bun"
            ? `You're running via bunx, which always fetches the latest on demand — there's nothing to upgrade. Keep using \`bunx ${pkg}@latest <command>\`.`
            : `You're running via npx, which always fetches the latest on demand — there's nothing to upgrade. Keep using \`npx ${pkg}@latest <command>\`.`,
      };
    case "global":
      return {
        runnable: true,
        command: globalUpdateCommand(install.manager, pkg),
        explanation: `Detected a global ${install.manager} install.`,
      };
    case "local": {
      const add = install.manager === "bun" ? `bun add ${pkg}@latest` : `npm install ${pkg}@latest`;
      return {
        runnable: false,
        command: add,
        explanation: `Detected a project-local install. Run this in the project that pins ${pkg} (often \`.smithers/\`).`,
      };
    }
    default:
      return {
        runnable: false,
        command: globalUpdateCommand(install.manager, pkg),
        explanation: `Could not detect the install method. If you installed Smithers globally, this is the likely upgrade command:`,
      };
  }
}

/**
 * Fetch the latest published version from the npm registry. Returns null on any
 * error (offline, timeout, malformed payload) — the caller treats null as "no
 * information, no notice".
 *
 * @param {{ pkg?: string; fetchImpl?: typeof fetch; timeoutMs?: number }} [opts]
 * @returns {Promise<string | null>}
 */
export async function fetchLatestVersion(opts = {}) {
  const pkg = opts.pkg ?? SMITHERS_PACKAGE;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") return null;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // The `/latest` endpoint returns a small document — far cheaper than the
    // full packument — and the `Accept` header keeps it minimal.
    const res = await fetchImpl(`https://registry.npmjs.org/${pkg}/latest`, {
      signal: controller.signal,
      headers: { accept: "application/vnd.npm.install-v1+json" },
    });
    if (!res?.ok) return null;
    const body = await res.json();
    const version = body?.version;
    return typeof version === "string" && version.length > 0 ? version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch the published SOTA model registry version. Returns null on any error —
 * same "no information, no notice" contract as {@link fetchLatestVersion}.
 *
 * @param {{ url?: string; fetchImpl?: typeof fetch; timeoutMs?: number }} [opts]
 * @returns {Promise<number | null>}
 */
export async function fetchRemoteSotaVersion(opts = {}) {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") return null;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(opts.url ?? SOTA_REGISTRY_URL, { signal: controller.signal });
    if (!res?.ok) return null;
    const body = await res.json();
    const version = body?.version;
    return Number.isInteger(version) && version > 0 ? version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {unknown} value
 * @param {Set<string>} out
 */
function collectChangelogVersionStrings(value, out) {
  if (typeof value === "string") {
    const match = value.match(/^changelogs\/(\d+\.\d+\.\d+)$/);
    if (match?.[1]) out.add(match[1]);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectChangelogVersionStrings(entry, out);
    return;
  }
  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) collectChangelogVersionStrings(entry, out);
  }
}

/**
 * Extract version ids from the docs sidebar and sort them oldest to newest.
 *
 * @param {unknown} docsJson
 * @returns {string[]}
 */
export function extractChangelogVersions(docsJson) {
  const versions = new Set();
  collectChangelogVersionStrings(docsJson, versions);
  return [...versions].sort((a, b) => compareVersions(a, b));
}

/**
 * @param {string[]} versions
 * @param {string} currentVersion
 * @param {string | null | undefined} latestVersion
 * @returns {string[]}
 */
export function filterChangelogVersionsSince(versions, currentVersion, latestVersion) {
  return versions.filter((version) => {
    if (compareVersions(version, currentVersion) <= 0) return false;
    if (latestVersion && compareVersions(version, latestVersion) > 0) return false;
    return true;
  });
}

/**
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<Response | null>}
 */
async function fetchWithTimeout(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    return res ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch changelog MDX files newer than the installed version. Missing individual
 * changelog pages are reported in-place so the caller can still proceed with
 * the versions that were reachable.
 *
 * @param {{
 *   currentVersion: string;
 *   latestVersion?: string | null;
 *   fetchImpl?: typeof fetch;
 *   timeoutMs?: number;
 *   indexUrl?: string;
 *   rawBaseUrl?: string;
 *   maxEntries?: number;
 *   maxCharsPerEntry?: number;
 * }} opts
 * @returns {Promise<{ versions: string[]; truncated: boolean; entries: Array<{ version: string; url: string; ok: boolean; content: string; error?: string }> }>}
 */
export async function fetchChangelogsSince(opts) {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const currentVersion = opts.currentVersion;
  if (typeof fetchImpl !== "function" || !currentVersion || currentVersion === "unknown") {
    return { versions: [], truncated: false, entries: [] };
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const indexUrl = opts.indexUrl ?? CHANGELOG_INDEX_URL;
  const rawBaseUrl = (opts.rawBaseUrl ?? CHANGELOG_RAW_BASE_URL).replace(/\/+$/, "");
  const maxEntries = Math.max(1, opts.maxEntries ?? DEFAULT_CHANGELOG_MAX_ENTRIES);
  const maxCharsPerEntry = Math.max(256, opts.maxCharsPerEntry ?? DEFAULT_CHANGELOG_MAX_CHARS);

  const indexRes = await fetchWithTimeout(fetchImpl, indexUrl, timeoutMs);
  if (!indexRes?.ok) {
    return { versions: [], truncated: false, entries: [] };
  }
  let docsJson;
  try {
    docsJson = await indexRes.json();
  } catch {
    return { versions: [], truncated: false, entries: [] };
  }

  const allVersions = filterChangelogVersionsSince(
    extractChangelogVersions(docsJson),
    currentVersion,
    opts.latestVersion,
  );
  const versions = allVersions.slice(0, maxEntries);
  const entries = [];
  for (const version of versions) {
    const url = `${rawBaseUrl}/${version}.mdx`;
    const res = await fetchWithTimeout(fetchImpl, url, timeoutMs);
    if (!res?.ok) {
      entries.push({
        version,
        url,
        ok: false,
        content: "",
        error: res ? `HTTP ${res.status}` : "fetch failed",
      });
      continue;
    }
    try {
      const text = await res.text();
      entries.push({
        version,
        url,
        ok: true,
        content: text.length > maxCharsPerEntry ? text.slice(0, maxCharsPerEntry) : text,
        ...(text.length > maxCharsPerEntry ? { error: `truncated to ${maxCharsPerEntry} chars` } : {}),
      });
    } catch {
      entries.push({ version, url, ok: false, content: "", error: "read failed" });
    }
  }

  return {
    versions,
    truncated: allVersions.length > versions.length,
    entries,
  };
}

/**
 * @param {string} markerPath
 * @returns {{ lastCheckMs?: number; latest?: string; sotaVersion?: number }}
 */
function readMarker(markerPath) {
  try {
    const parsed = JSON.parse(readFileSync(markerPath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * @param {string} markerPath
 * @param {{ lastCheckMs: number; latest: string | null; sotaVersion: number | null }} data
 */
function writeMarker(markerPath, data) {
  try {
    mkdirSync(dirname(markerPath), { recursive: true });
    writeFileSync(markerPath, `${JSON.stringify(data, null, 2)}\n`);
  } catch {
    /* a missing marker just means we re-check next time — harmless */
  }
}

/**
 * Resolve the latest version with a once-a-day network budget, and report
 * whether the current install is behind it.
 *
 * The marker (`~/.smithers/update-check.json`) caches the last-seen latest
 * version and the timestamp of the last network check. Between checks we reuse
 * the cached version so the notice keeps showing without re-hitting npm; once
 * the window elapses we refresh from the registry. Set
 * `SMITHERS_NO_UPDATE_CHECK=1` to disable entirely.
 *
 * @param {{
 *   currentVersion: string;
 *   homeDir?: string;
 *   env?: NodeJS.ProcessEnv;
 *   now?: number;
 *   fetchImpl?: typeof fetch;
 *   timeoutMs?: number;
 *   intervalMs?: number;
 *   force?: boolean;
 *   currentSotaVersion?: number;
 * }} opts
 * @returns {Promise<{ current: string; latest: string; updateAvailable: boolean; checkedNow: boolean; sotaVersion: number | null; sotaUpdateAvailable: boolean } | null>}
 */
export async function ensureUpdateCheck(opts) {
  try {
    const env = opts.env ?? process.env;
    if (env.SMITHERS_NO_UPDATE_CHECK === "1") return null;
    const current = opts.currentVersion;
    if (!current || current === "unknown") return null;
    const currentSotaVersion = opts.currentSotaVersion ?? SOTA_REGISTRY_VERSION;

    const homeDir = opts.homeDir ?? env.HOME ?? homedir();
    const markerPath = join(homeDir, ".smithers", "update-check.json");
    const marker = readMarker(markerPath);
    const nowMs = opts.now ?? Date.now();
    const intervalMs = opts.intervalMs ?? UPDATE_CHECK_INTERVAL_MS;
    // An absent timestamp means we've never checked — always check then, rather
    // than waiting a full interval from epoch.
    const neverChecked = typeof marker.lastCheckMs !== "number";
    const lastCheckMs = neverChecked ? 0 : marker.lastCheckMs;

    let latest = typeof marker.latest === "string" ? marker.latest : null;
    let sotaVersion = Number.isInteger(marker.sotaVersion) ? marker.sotaVersion : null;
    let checkedNow = false;
    if (opts.force || neverChecked || nowMs - lastCheckMs >= intervalMs) {
      const [fetched, fetchedSota] = await Promise.all([
        fetchLatestVersion({ fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs }),
        fetchRemoteSotaVersion({ fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs }),
      ]);
      checkedNow = true;
      // Persist the check time even on a failed fetch so a flaky network does
      // not turn into a per-command retry storm. Keep the last known values.
      if (fetched) latest = fetched;
      if (fetchedSota) sotaVersion = fetchedSota;
      writeMarker(markerPath, { lastCheckMs: nowMs, latest, sotaVersion });
    }

    if (!latest) return null;
    return {
      current,
      latest,
      updateAvailable: isUpdateAvailable(latest, current),
      checkedNow,
      sotaVersion,
      sotaUpdateAvailable: sotaVersion != null && sotaVersion > currentSotaVersion,
    };
  } catch {
    return null;
  }
}

/**
 * One-line stderr notice when an update is available, or null. The detected
 * install method decides whether we point at `smithers update` (it can act) or
 * at the next `@latest` run (transient runners).
 *
 * A newer SOTA model registry alone (merged to main, no release cut yet) stays
 * silent: nudging users to update to a version that does not carry the new
 * registry would be wrong. Once the release exists both facts are true and the
 * notice covers models too.
 *
 * @param {{ current: string; latest: string; updateAvailable: boolean; sotaUpdateAvailable?: boolean } | null} check
 * @param {ReturnType<typeof detectInstallMethod>} [install]
 * @returns {string | null}
 */
export function formatUpdateNotice(check, install) {
  if (!check?.updateAvailable) return null;
  const models = check.sotaUpdateAvailable
    ? " New SOTA models are in — after upgrading, run `smithers init` to refresh your workflows to the latest agents."
    : "";
  const head = `↑ Smithers ${check.latest} is available (you have ${check.current}).`;
  if (install?.kind === "bunx") {
    const runner = install.manager === "npm" ? "npx" : "bunx";
    return `${head} You're on ${runner} — the next \`${runner} ${SMITHERS_PACKAGE}@latest\` run picks it up.${models}`;
  }
  return `${head} Run \`smithers update\` to upgrade.${models}`;
}
