import { readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Marker that brackets the smithers-managed block inside an agent doc. Used to
 * detect a prior install so re-running `smithers init` is idempotent, and so a
 * future uninstall could strip exactly the block we added.
 */
const BLOCK_START = "<!-- smithers:prefer-workflows START -->";
const BLOCK_END = "<!-- smithers:prefer-workflows END -->";

/**
 * Agent instruction files we append guidance to, matched case-insensitively
 * against what's on disk (so `claude.md`, `Claude.md`, `agents.md`, etc. all
 * count). `AGENTS.md` is the agentsmd.dev convention; `CLAUDE.md` is Claude
 * Code's.
 */
const DEFAULT_FILE_NAMES = ["CLAUDE.md", "AGENTS.md"];

/**
 * The guidance appended to an existing agent doc. Lets the coding agent decide
 * per request whether smithers.sh durability is worth it, while nudging toward
 * workflows for multi-step plans and surfacing the "save this as a workflow"
 * affordance once a session lands.
 */
const PREFERENCE_BLOCK = [
  BLOCK_START,
  "## Smithers workflows",
  "",
  "Use your best judgment, weighing speed, quality, and token usage, to decide",
  "whether a request should run as a [smithers.sh](https://smithers.sh) workflow",
  "or with regular subagents. Prefer a smithers workflow for multi-step plans and",
  "for work that benefits from retries, approvals, review, or replay; reach for",
  "plain subagents when a request is a quick one-off.",
  "",
  "The `smithers` skill is installed: run `smithers workflow list` to see the",
  "available workflows and `smithers workflow run <id>` to launch one.",
  "",
  "When a session ends successfully and the work could have been a smithers",
  "workflow, offer to turn the session into a reusable smithers workflow for next",
  "time.",
  BLOCK_END,
  "",
].join("\n");

/**
 * @typedef {{ status: "updated" | "already-present" | "failed"; path: string; reason?: string; }} AgentDocNoteResult
 * @typedef {{ files: AgentDocNoteResult[] }} AgentDocsNoteSummary
 */

/**
 * Append the smithers-workflow guidance block to each existing agent doc
 * (`CLAUDE.md` / `AGENTS.md`, case-insensitive) in the project root. We only
 * ever touch files that already exist: `smithers init` should not create an
 * agent doc for projects that don't keep one.
 *
 * Each edit is idempotent (keyed off {@link BLOCK_START}) and best-effort: a
 * read or write failure on one file is recorded and never aborts init. The
 * block is appended so any hand-written instructions above it keep their
 * precedence position. Files that resolve to the same inode (e.g. `AGENTS.md`
 * symlinked to `CLAUDE.md`) are edited once.
 *
 * @param {{ projectRoot: string; fileNames?: string[] }} opts
 * @returns {AgentDocsNoteSummary}
 */
export function noteWorkflowPreferenceInAgentDocs(opts) {
  const wanted = new Set((opts.fileNames ?? DEFAULT_FILE_NAMES).map((name) => name.toLowerCase()));
  /** @type {string[]} */
  let entries;
  try {
    entries = readdirSync(opts.projectRoot);
  } catch {
    // No readable project root (or it doesn't exist): nothing to edit.
    return { files: [] };
  }
  /** @type {AgentDocNoteResult[]} */
  const files = [];
  const editedInodes = new Set();
  for (const entry of entries) {
    if (!wanted.has(entry.toLowerCase())) continue;
    const path = join(opts.projectRoot, entry);
    files.push(noteOne(path, editedInodes));
  }
  return { files };
}

/**
 * Append the block to a single agent doc, deduping by resolved inode so a
 * symlinked alias isn't edited twice.
 *
 * @param {string} path
 * @param {Set<string>} editedInodes
 * @returns {AgentDocNoteResult}
 */
function noteOne(path, editedInodes) {
  try {
    const realPath = realpathSync(path);
    if (editedInodes.has(realPath)) {
      return { status: "already-present", path };
    }
    const existing = readFileSync(realPath, "utf8");
    if (existing.includes(BLOCK_START)) {
      editedInodes.add(realPath);
      return { status: "already-present", path };
    }
    const separator = existing.length === 0 || existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
    writeFileSync(realPath, existing + separator + PREFERENCE_BLOCK, "utf8");
    editedInodes.add(realPath);
    return { status: "updated", path };
  } catch (err) {
    return { status: "failed", path, reason: err?.message ?? String(err) };
  }
}
