// Oneshot dirty-working-copy preflight.
//
// `smithers oneshot --cwd <dir>` runs the agent directly in whatever tree that
// path points at. When that tree already carries foreign work — another
// session's uncommitted edits, a stale detached lineage, `.jjconflict-base-*`
// mirror trees left by a jj conflict — the agent's own commits sweep it up, and
// landing the result turns into a manual per-file blob port. This module
// detects that state cheaply and renders the two things the CLI needs from a
// single source of truth: the operator warning and the agent triage preamble.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 32 * 1024 * 1024;
// Porcelain v1 status codes for unmerged (conflicted) entries.
const UNMERGED_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
const JJ_CONFLICT_PREFIX = ".jjconflict";

/**
 * @typedef {{ modified: number; untracked: number; staged: number; conflicted: number }} DirtyCounts
 * @typedef {{
 *   vcs: "git";
 *   clean: boolean;
 *   cwd: string;
 *   root: string | null;
 *   dirty: DirtyCounts;
 *   jjConflictPaths: string[];
 *   detachedHead: boolean;
 * }} GitWorkingCopySummary
 * @typedef {GitWorkingCopySummary | { vcs: "none" } | { vcs: "unknown" }} WorkingCopySummary
 */

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {{ available: boolean; ok: boolean; stdout: string }}
 */
function runGit(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
    windowsHide: true,
  });
  if (result.error) return { available: false, ok: false, stdout: "" };
  return { available: true, ok: result.status === 0, stdout: result.stdout ?? "" };
}

/**
 * @param {string} cwd
 * @param {WorkingCopySummary["vcs"]} vcs
 * @returns {WorkingCopySummary}
 */
function skipped(vcs) {
  return { vcs };
}

/**
 * `git status --porcelain=v1 -z` emits `XY <path>\0`, with renames and copies
 * appending a second NUL-terminated field for the source path.
 *
 * @param {string} stdout
 * @returns {{ code: string; path: string }[]}
 */
function parsePorcelainZ(stdout) {
  const fields = stdout.split("\0");
  const entries = [];
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (field.length < 4) continue;
    const code = field.slice(0, 2);
    entries.push({ code, path: field.slice(3) });
    if (code[0] === "R" || code[0] === "C") index += 1;
  }
  return entries;
}

/** @param {string} path */
function jjConflictRoot(path) {
  const segments = path.split("/");
  const index = segments.findIndex((segment) => segment.startsWith(JJ_CONFLICT_PREFIX));
  return index < 0 ? null : segments.slice(0, index + 1).join("/");
}

/**
 * Detect the VCS state at the oneshot working directory. Never throws: an
 * unreadable or exotic repo degrades to `{ vcs: "unknown" }` so a preflight
 * problem can never block the goal.
 *
 * @param {string} taskCwd
 * @returns {WorkingCopySummary}
 */
export function assessWorkingCopy(taskCwd) {
  try {
    const toplevel = runGit(taskCwd, ["rev-parse", "--show-toplevel"]);
    if (!toplevel.available) return skipped("unknown");
    if (!toplevel.ok) return skipped("none");
    const root = toplevel.stdout.trim() || null;
    const status = runGit(taskCwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    if (!status.ok) return skipped("unknown");
    const entries = parsePorcelainZ(status.stdout);
    const dirty = { modified: 0, untracked: 0, staged: 0, conflicted: 0 };
    const jjConflictPaths = new Set();
    for (const entry of entries) {
      const jjConflictPath = jjConflictRoot(entry.path);
      if (jjConflictPath) jjConflictPaths.add(jjConflictPath);
      if (UNMERGED_CODES.has(entry.code)) {
        dirty.conflicted += 1;
        continue;
      }
      if (entry.code === "??") {
        dirty.untracked += 1;
        continue;
      }
      if (entry.code === "!!") continue;
      const [index, worktree] = entry.code;
      if (index !== " ") dirty.staged += 1;
      if (index !== " " || worktree !== " ") dirty.modified += 1;
    }
    // A `.jjconflict-base-*` mirror tree can also sit at the repo root fully
    // ignored, invisible to `git status` yet very much in the agent's way.
    if (root) {
      try {
        for (const name of readdirSync(root)) {
          if (name.startsWith(JJ_CONFLICT_PREFIX)) jjConflictPaths.add(name);
        }
      } catch {
        // An unreadable root is not worth failing the launch over.
      }
    }
    const paths = [...jjConflictPaths].sort();
    const clean = entries.length === 0 && paths.length === 0;
    const detached = runGit(taskCwd, ["symbolic-ref", "--quiet", "HEAD"]);
    return {
      vcs: "git",
      clean,
      cwd: taskCwd,
      root,
      dirty,
      jjConflictPaths: paths,
      detachedHead: detached.available && !detached.ok,
    };
  } catch {
    return skipped("unknown");
  }
}

/**
 * True when the summary describes a working copy the operator should be warned
 * about (a git repo that is not clean).
 *
 * @param {GitWorkingCopySummary} summary
 */
export function needsPreflightNotice(summary) {
  return summary.vcs === "git" && !summary.clean;
}

/** @param {GitWorkingCopySummary} summary */
function describeInventory(summary) {
  const counts = [
    [summary.dirty.modified, "modified"],
    [summary.dirty.untracked, "untracked"],
    [summary.dirty.staged, "staged"],
    [summary.dirty.conflicted, "conflicted"],
  ].filter(([count]) => count > 0);
  const inventory =
    counts.length > 0
      ? `${counts.map(([count, label]) => `${count} ${label}`).join(", ")} file(s)`
      : "no pending file changes";
  const extras = [];
  if (summary.detachedHead) extras.push("detached HEAD");
  if (summary.jjConflictPaths.length > 0) extras.push(`${summary.jjConflictPaths.length} .jjconflict path(s)`);
  return extras.length > 0 ? `${inventory} (${extras.join(", ")})` : inventory;
}

/**
 * Render the operator warning and the agent triage preamble from one summary.
 *
 * @param {GitWorkingCopySummary} summary
 * @param {string} runId
 * @returns {{ warning: string; preamble: string }}
 */
export function buildPreflightNotice(summary, runId) {
  const inventory = describeInventory(summary);
  const warning = `oneshot preflight: working copy at ${summary.cwd} has ${inventory}; pre-existing work can be swept into or block the agent's commits`;
  const preamble = [
    "## Working-copy preflight",
    "",
    `This working copy was NOT clean when the run started: ${summary.cwd} has ${inventory}.`,
    "None of it is yours. Before you start the goal below, bring the tree to a clean",
    "baseline, judging every pre-existing path on its merits:",
    "",
    "- Build artifacts, caches, logs, or junk that should never be tracked: add the",
    "  narrowest sensible pattern to `.gitignore`.",
    "- Meaningful pre-existing work: preserve it in its own snapshot commit",
    `  (\`chore(preflight): preserve pre-existing working-copy changes before ${runId}\`).`,
    "  Never let it ride along in a goal commit.",
    "- Ambiguous or half-finished experiments: `git stash push` them with a message",
    `  describing what they are and naming this run (\`preflight ${runId}: ...\`).`,
    "- Conflicted/`UU` files or `.jjconflict*` trees: do NOT resolve, commit, or delete",
    "  them. Stop, surface them in your run output as a blocker note, and continue with",
    "  the goal only if the goal does not touch those paths.",
    "",
    "Then, while doing the goal itself:",
    "",
    "- `git add` every NEW file you create and include it in your commits. A previous",
    "  run pushed code importing a file it never committed and left the CLI unbootable.",
    "- Goal commits contain only goal work: no pre-existing changes, no unrelated paths.",
    "",
    "---",
  ].join("\n");
  return { warning, preamble };
}

/**
 * Durable record of what the preflight saw, stored in the run config next to
 * the rest of the oneshot launch metadata.
 *
 * @param {"auto" | "warn" | "off"} mode
 * @param {WorkingCopySummary | null} summary
 */
export function preflightConfigEntry(mode, summary) {
  if (!summary) return { mode };
  if (summary.vcs !== "git") return { mode, vcs: summary.vcs };
  return {
    mode,
    vcs: summary.vcs,
    clean: summary.clean,
    dirty: summary.dirty,
    detachedHead: summary.detachedHead,
    jjConflictPaths: summary.jjConflictPaths.length,
  };
}
