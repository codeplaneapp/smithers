import { createHash } from "node:crypto";
import { z } from "zod/v4";

/**
 * Pure logic for the stacked-ship workflow: PR-plan validation, jj stack
 * naming, clean-commit hygiene verdicts, approval-decision classification,
 * command-plan builders, and jj output parsing. No I/O lives here; the
 * workflow's compute tasks own process execution and feed transcripts in.
 * Spec: .smithers/specs/stacked-ship-workflow.md
 */

// ── Plan ─────────────────────────────────────────────────────────────────────

export const prPlanEntrySchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,47}$/, "slug must be kebab-case, 2-48 chars"),
  title: z.string().min(8),
  goal: z.string().min(20),
  scopes: z.array(z.string().min(1)).min(1),
  checks: z.array(z.string().min(1)).default([]),
  storyHint: z.string().default(""),
});
export type PrPlanEntry = z.infer<typeof prPlanEntrySchema>;

export const stackPlanSchema = z.object({
  missionTitle: z.string().min(4),
  assembleChecks: z.array(z.string().min(1)).default([]),
  entries: z.array(prPlanEntrySchema).min(1),
});
export type StackPlan = z.infer<typeof stackPlanSchema>;

/**
 * Parse and validate a stack plan from an agent's JSON output (string or
 * object). Throws on malformed plans and duplicate slugs; clamps the entry
 * list to maxPrs so a runaway planner cannot fan out unbounded lanes.
 */
export function parseStackPlan(raw: unknown, maxPrs: number): StackPlan {
  let value: unknown = raw;
  if (typeof raw === "string") {
    const text = raw.trim();
    if (!text) throw new Error("stack plan is empty");
    value = JSON.parse(text);
  }
  const plan = stackPlanSchema.parse(value);
  const seen = new Set<string>();
  for (const entry of plan.entries) {
    if (seen.has(entry.slug)) throw new Error("duplicate plan slug: " + entry.slug);
    seen.add(entry.slug);
  }
  const cap = Math.max(1, Math.floor(maxPrs));
  return { ...plan, entries: plan.entries.slice(0, cap) };
}

/**
 * Read a persisted plan row (possibly `.row`-wrapped, arrays possibly stored
 * as JSON strings) back into a validated StackPlan. Returns null when the row
 * is absent or unusable rather than throwing, so render code can gate on it.
 */
export function planFromRow(row: unknown, maxPrs: number): StackPlan | null {
  if (typeof row !== "object" || row === null) return null;
  const record = row as Record<string, unknown>;
  const inner =
    typeof record.row === "object" && record.row !== null ? (record.row as Record<string, unknown>) : record;
  const coerce = (value: unknown): unknown => {
    if (typeof value !== "string") return value;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  };
  try {
    return parseStackPlan(
      {
        missionTitle: inner.missionTitle ?? inner.mission_title,
        assembleChecks: coerce(inner.assembleChecks ?? inner.assemble_checks) ?? [],
        entries: coerce(inner.entries),
      },
      maxPrs,
    );
  } catch {
    return null;
  }
}

// ── Naming ───────────────────────────────────────────────────────────────────

export function stackKeyFromRunId(rawRunId: string): string {
  const readable = rawRunId.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 27) || "run";
  const hash = createHash("sha256").update(rawRunId).digest("hex").slice(0, 12);
  return readable + "-" + hash;
}

export function stackOwnerMarker(rawRunId: string): string {
  return JSON.stringify({ version: 1, runId: rawRunId }) + "\n";
}

export function stackOwnerMatches(marker: string, rawRunId: string): boolean {
  try {
    const parsed = JSON.parse(marker);
    return parsed?.version === 1 && parsed?.runId === rawRunId;
  } catch {
    return false;
  }
}

export function bookmarkFor(stackKey: string, slug: string): string {
  return "stack/" + stackKey + "/" + slug;
}

export function baseBookmarkFor(stackKey: string): string {
  return "stack/" + stackKey + "/base";
}

export function workspaceNameFor(slug: string): string {
  return "pr-" + slug;
}

/** Parent revision of a lane: the previous lane's bookmark, or the stack base. */
export function parentRevFor(stackKey: string, entries: PrPlanEntry[], index: number): string {
  if (index <= 0) return baseBookmarkFor(stackKey);
  return bookmarkFor(stackKey, entries[index - 1].slug);
}

// ── Clean-commit hygiene ─────────────────────────────────────────────────────

const COMMIT_TYPES = ["feat", "fix", "chore", "docs", "test", "refactor", "perf", "polish", "ci", "build", "style"];
const COMMIT_RE = new RegExp("^(\\S+) (" + COMMIT_TYPES.join("|") + ")\\(([a-z0-9./-]+)\\): (.{8,})");

/**
 * Enforce the repo commit style: `<emoji> <type>(<scope>): <subject>` with a
 * subject of at least 8 characters. The first token only has to be a
 * non-space glyph (emoji classes are unreliable across engines).
 */
export function commitMessageCheck(description: string): { ok: boolean; reason: string } {
  const first = (description ?? "").split("\n", 1)[0] ?? "";
  if (!first.trim()) return { ok: false, reason: "empty change description" };
  const match = COMMIT_RE.exec(first);
  if (!match) {
    return {
      ok: false,
      reason:
        'description "' +
        first.slice(0, 80) +
        '" does not match "<emoji> <type>(<scope>): <subject>" (types: ' +
        COMMIT_TYPES.join("/") +
        ")",
    };
  }
  if (/^[a-zA-Z0-9]+$/.test(match[1])) {
    return { ok: false, reason: 'description must start with an emoji, got "' + match[1] + '"' };
  }
  return { ok: true, reason: "" };
}

/**
 * A scope entry allows a path when it is "**" (anything), an exact file
 * match, or a directory prefix (`apps/studio` or `apps/studio/**` both allow
 * everything under apps/studio).
 */
export function pathAllowed(path: string, scopes: string[]): boolean {
  const clean = path.replace(/\\/g, "/").replace(/^\.\//, "");
  for (const rawScope of scopes) {
    const scope = rawScope
      .replace(/\\/g, "/")
      .replace(/^\.\//, "")
      .replace(/\/\*\*$/, "")
      .replace(/\/$/, "");
    if (rawScope === "**" || scope === "**" || scope === "") return true;
    if (clean === scope) return true;
    if (clean.startsWith(scope + "/")) return true;
  }
  return false;
}

export type CheckResult = { command: string; exitCode: number; tail: string };

export type HygieneInput = {
  changeCount: number;
  description: string;
  changedPaths: string[];
  scopes: string[];
  conflictedCount: number;
  checks: CheckResult[];
};

export type HygieneVerdict = { ok: boolean; reasons: string[]; feedback: string };

/**
 * Fold the mechanical facts about a lane revision into a verdict. Reasons are
 * ordered by how fundamental the violation is; feedback is the concatenation
 * an implement/rework prompt can consume verbatim.
 */
export function hygieneVerdict(input: HygieneInput): HygieneVerdict {
  const reasons: string[] = [];
  if (input.changeCount !== 1) {
    reasons.push(
      "the lane must be exactly one jj change; found " +
        input.changeCount +
        (input.changeCount > 1 ? " (squash into one with `jj squash`)" : " (the change has no content yet)"),
    );
  }
  const message = commitMessageCheck(input.description);
  if (!message.ok) reasons.push(message.reason);
  if (input.changedPaths.length === 0) {
    reasons.push("the diff against the parent is empty");
  }
  const outOfScope = input.changedPaths.filter((path) => !pathAllowed(path, input.scopes));
  if (outOfScope.length > 0) {
    reasons.push(
      "paths outside the lane scopes (" +
        input.scopes.join(", ") +
        "): " +
        outOfScope.slice(0, 12).join(", ") +
        (outOfScope.length > 12 ? " (+" + (outOfScope.length - 12) + " more)" : ""),
    );
  }
  if (input.conflictedCount > 0) {
    reasons.push(
      input.conflictedCount +
        " descendant change(s) are conflicted after restack; resolve them (`jj resolve` in the affected lane) before this revision counts as clean",
    );
  }
  for (const check of input.checks) {
    if (check.exitCode !== 0) {
      reasons.push("check failed (exit " + check.exitCode + "): " + check.command + "\n" + check.tail.slice(-1_500));
    }
  }
  return {
    ok: reasons.length === 0,
    reasons,
    feedback: reasons.length === 0 ? "" : "HYGIENE FAILURES:\n- " + reasons.join("\n- "),
  };
}

// ── Approval decisions ───────────────────────────────────────────────────────

export type DecisionState = "approved" | "denied" | "pending";

function unwrapRow(row: unknown): Record<string, unknown> | null {
  if (typeof row !== "object" || row === null) return null;
  const record = row as Record<string, unknown>;
  const inner = record.row;
  if (typeof inner === "object" && inner !== null) return inner as Record<string, unknown>;
  return record;
}

/** Read an approval decision row (possibly `.row`-wrapped, 0/1 booleans). */
export function classifyDecision(row: unknown): DecisionState {
  const record = unwrapRow(row);
  if (!record) return "pending";
  const approved = record.approved;
  if (approved === true || approved === 1 || approved === "1" || approved === "true") return "approved";
  if (approved === false || approved === 0 || approved === "0" || approved === "false") return "denied";
  return "pending";
}

export function decisionNote(row: unknown): string {
  const record = unwrapRow(row);
  const note = record?.note ?? record?.reason;
  return typeof note === "string" ? note : "";
}

// ── Lane phase folding (UI + summary) ────────────────────────────────────────

export type LanePhase = "pending" | "building" | "reviewing" | "approved" | "unapproved" | "blocked";

export function lanePhase(state: {
  hasWorkspace: boolean;
  hygieneOk: boolean;
  selfReviewApproved: boolean;
  decision: DecisionState;
  buildExhausted: boolean;
  reviewExhausted: boolean;
}): LanePhase {
  if (!state.hasWorkspace) return "pending";
  if (state.decision === "approved") return "approved";
  if (!state.hygieneOk || !state.selfReviewApproved) {
    return state.buildExhausted ? "blocked" : "building";
  }
  if (state.reviewExhausted) return "unapproved";
  return "reviewing";
}

// ── Command plans (pure argv builders; the workflow executes them) ───────────

export type CommandStep = { argv: string[]; cwd: "root" | "workspace" };

export function cloneCommands(options: { sourceRoot: string; originUrl: string; destDir: string }): string[][] {
  const commands: string[][] = [["git", "clone", "--no-hardlinks", options.sourceRoot, options.destDir]];
  if (options.originUrl) {
    commands.push(["git", "-C", options.destDir, "remote", "set-url", "origin", options.originUrl]);
  }
  return commands;
}

export function laneWorkspaceCommands(options: {
  slug: string;
  parentRev: string;
  bookmark: string;
  workspaceDir: string;
}): CommandStep[] {
  return [
    {
      argv: [
        "jj",
        "workspace",
        "add",
        "--name",
        workspaceNameFor(options.slug),
        "--revision",
        options.parentRev,
        options.workspaceDir,
      ],
      cwd: "root",
    },
    { argv: ["jj", "bookmark", "set", options.bookmark, "-r", "@", "--allow-backwards"], cwd: "workspace" },
  ];
}

// ── jj output parsing ────────────────────────────────────────────────────────

/** Count non-empty lines (jj log with a one-field template, one row per line). */
export function countLogLines(stdout: string): number {
  return stdout.split("\n").filter((line) => line.trim().length > 0).length;
}

/**
 * Parse `jj diff --summary` output ("M path", "A path", "D path", and rename
 * lines "R old -> new") into the list of touched paths.
 */
export function parseSummaryPaths(stdout: string): string[] {
  const paths: string[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const match = /^([A-Z])\s+(.+)$/.exec(line);
    if (!match) continue;
    const rest = match[2];
    const rename = /^(.+?)\s+->\s+(.+)$/.exec(rest);
    if (rename) {
      paths.push(rename[1].trim(), rename[2].trim());
    } else {
      paths.push(rest.trim());
    }
  }
  return [...new Set(paths)];
}

// ── Artifact paths ───────────────────────────────────────────────────────────

export function reportsDirFor(repoRoot: string, stackKey: string): string {
  return [repoRoot.replace(/\/+$/, ""), ".smithers", "reports", "stacked-ship", stackKey].join("/");
}

export function artifactFileName(slug: string, revision: number): string {
  return slug + "-r" + Math.max(0, Math.floor(revision)) + ".html";
}
