/**
 * Pure helpers for the flows-migration workflow.
 *
 * The workflow drives a three-stage program that replaces the Smithers runtime
 * with the flows library (see .smithers/specs/flows-migration.md). Everything
 * here is side-effect free so it can be unit tested without a run.
 */

import { join } from "node:path";

export type Repo = "smithers" | "flows";

export type Lane = {
  slug: string;
  stage: string;
  repo: Repo;
  title: string;
  goal: string;
  scopes: string[];
  checks: string[];
  dependsOn: string[];
};

export type StageEntry = {
  id: string;
  title: string;
  goal: string;
  checks: string[];
  lanes: Lane[];
};

export type Ledger = {
  missionTitle: string;
  stages: StageEntry[];
  summary: string;
};

export type LanePhase =
  | "pending"
  | "workspace"
  | "implementing"
  | "gate-red"
  | "reviewing"
  | "awaiting-approval"
  | "approved"
  | "denied"
  | "exhausted"
  | "blocked";

const STAGE_IDS = ["0", "1", "2", "3"] as const;

/** Every stage id the spec defines, in execution order. */
export const ALL_STAGES: readonly string[] = STAGE_IDS;

/** Leading binaries a lane check is allowed to invoke. */
export const CHECK_ALLOWLIST: readonly string[] = [
  "pnpm",
  "bun",
  "bunx",
  "npm",
  "npx",
  "node",
  "jj",
  "git",
  "cargo",
  "tsc",
  "biome",
  "vitest",
  "make",
];

const SHELL_METACHARACTERS = /[;&|`$><\n\r]|\$\(/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Unwrap a persisted output row, which may arrive wrapped as `{ row: {...} }`. */
export function unwrapRow(value: unknown): Record<string, unknown> {
  const outer = isRecord(value) ? value : {};
  return isRecord(outer.row) ? (outer.row as Record<string, unknown>) : outer;
}

/** Read a field that may have been persisted as a JSON string. */
export function readList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function asStringList(value: unknown): string[] {
  return readList(value)
    .map((entry) => asString(entry))
    .filter((entry) => entry.length > 0);
}

/** Lowercase, dash-separated, filesystem and bookmark safe. */
export function sanitizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/** Stable per-run key derived from the run id, used for every path and bookmark. */
export function migrationKeyFromRunId(runId: string): string {
  const tail = String(runId ?? "")
    .replace(/[^A-Za-z0-9]+/g, "")
    .slice(-10);
  return tail || "local";
}

/** Root of the private workspace tree this run owns, inside the target repo. */
export function workspaceRootFor(repoRoot: string, key: string): string {
  return join(repoRoot, ".smithers", "workflows", ".worktrees", "flows-migration-" + key);
}

/** Directory of one lane's jj workspace. */
export function laneDirFor(repoRoot: string, key: string, slug: string): string {
  return join(workspaceRootFor(repoRoot, key), sanitizeSlug(slug));
}

/** jj workspace name for a lane. Workspace names are global to the repo. */
export function workspaceNameFor(key: string, slug: string): string {
  return "fm-" + key + "-" + sanitizeSlug(slug);
}

/**
 * Bookmark the integrator leaves a finished stage on, in each repo that had
 * lanes. The next stage's lanes branch from it, so stage N sees stage N-1's
 * work; without that they branch from trunk and every earlier stage is
 * invisible to them.
 */
export function stageBookmarkFor(key: string, stageId: string): string {
  return "flows-migration/" + key + "/stage-" + sanitizeSlug(stageId);
}

/** Bookmark a lane commits onto. */
export function bookmarkFor(key: string, slug: string): string {
  return "flows-migration/" + key + "/" + sanitizeSlug(slug);
}

/** Directory holding this run's HTML reports, always inside the Smithers repo. */
export function reportsDirFor(smithersRoot: string, key: string): string {
  return join(smithersRoot, ".smithers", "reports", "flows-migration", key);
}

/** File name of one lane's report revision. */
export function artifactFileName(slug: string, revision: number): string {
  return sanitizeSlug(slug) + "-r" + String(Math.max(1, Math.trunc(revision))) + ".html";
}

/** Rejects a check that shells out, and any binary outside the allowlist. */
export function isAllowedCheck(command: string): boolean {
  const trimmed = String(command ?? "").trim();
  if (!trimmed) return false;
  if (SHELL_METACHARACTERS.test(trimmed)) return false;
  const [binary] = trimmed.split(/\s+/);
  return CHECK_ALLOWLIST.includes(binary);
}

/** Split a check into argv, dropping anything the allowlist rejects. */
export function parseCheck(command: string): { binary: string; args: string[] } | null {
  if (!isAllowedCheck(command)) return null;
  const parts = String(command).trim().split(/\s+/);
  return { binary: parts[0], args: parts.slice(1) };
}

function normalizeLane(raw: unknown, stageId: string, index: number): Lane | null {
  if (!isRecord(raw)) return null;
  const slug = sanitizeSlug(asString(raw.slug, "lane-" + stageId + "-" + String(index + 1)));
  if (!slug) return null;
  const repo: Repo = asString(raw.repo, "smithers") === "flows" ? "flows" : "smithers";
  const checks = asStringList(raw.checks).filter(isAllowedCheck);
  return {
    slug,
    stage: stageId,
    repo,
    title: asString(raw.title, slug),
    goal: asString(raw.goal, ""),
    scopes: asStringList(raw.scopes),
    checks,
    dependsOn: asStringList(raw.dependsOn).map(sanitizeSlug),
  };
}

/**
 * Normalize a planner row into the ledger the workflow renders from.
 * Tolerates JSON-string arrays, unknown stage ids, and duplicate slugs.
 */
export function parseLedger(
  raw: unknown,
  options: { maxLanesPerStage?: number; stages?: readonly string[] } = {},
): Ledger | null {
  const row = unwrapRow(raw);
  const maxLanes = Math.max(1, options.maxLanesPerStage ?? 12);
  const allowed = new Set(options.stages ?? ALL_STAGES);
  const stagesRaw = readList(row.stages);
  if (stagesRaw.length === 0) return null;

  const seen = new Set<string>();
  const stages: StageEntry[] = [];
  for (const stageRaw of stagesRaw) {
    if (!isRecord(stageRaw)) continue;
    const id = asString(stageRaw.id);
    if (!allowed.has(id)) continue;
    const lanes: Lane[] = [];
    readList(stageRaw.lanes).forEach((laneRaw, index) => {
      if (lanes.length >= maxLanes) return;
      const lane = normalizeLane(laneRaw, id, index);
      if (!lane || seen.has(lane.slug)) return;
      seen.add(lane.slug);
      lanes.push(lane);
    });
    if (lanes.length === 0) continue;
    stages.push({
      id,
      title: asString(stageRaw.title, "Stage " + id),
      goal: asString(stageRaw.goal, ""),
      checks: asStringList(stageRaw.checks).filter(isAllowedCheck),
      lanes,
    });
  }
  if (stages.length === 0) return null;
  stages.sort((a, b) => a.id.localeCompare(b.id));
  return {
    missionTitle: asString(row.missionTitle, "Flows migration"),
    stages,
    summary: asString(row.summary, ""),
  };
}

/** Parse the `stages` input ("all", "1", "0,1") into an ordered stage id list. */
export function parseStageSelection(raw: string): string[] {
  const trimmed = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!trimmed || trimmed === "all" || trimmed === "*") return [...ALL_STAGES];
  const wanted = new Set(
    trimmed
      .split(/[,\s]+/)
      .map((entry) => entry.replace(/^stage-?/, ""))
      .filter((entry) => entry.length > 0),
  );
  const selected = ALL_STAGES.filter((id) => wanted.has(id));
  return selected.length > 0 ? selected : [...ALL_STAGES];
}

/** True when a row reports `ok`, whether persisted as boolean, 1, or "1". */
export function rowOk(row: unknown): boolean {
  const record = unwrapRow(row);
  const value = record.ok;
  return value === true || value === 1 || value === "1";
}

/** The phase label the UI and the reports show for one lane. */
export function lanePhase(state: {
  hasWorkspace: boolean;
  implemented: boolean;
  blocked: boolean;
  gateOk: boolean;
  reviewApproved: boolean;
  decision: "approved" | "denied" | "pending";
  buildExhausted: boolean;
  reviewExhausted: boolean;
}): LanePhase {
  if (state.blocked) return "blocked";
  if (!state.hasWorkspace) return "pending";
  if (state.decision === "approved") return "approved";
  if (state.buildExhausted && !state.gateOk) return "exhausted";
  if (!state.implemented) return "workspace";
  if (!state.gateOk) return "gate-red";
  if (!state.reviewApproved) return "reviewing";
  if (state.decision === "denied") return state.reviewExhausted ? "exhausted" : "denied";
  return "awaiting-approval";
}

/** Compact one gate result into the line the approval request shows. */
export function summarizeGate(gate: unknown): string {
  const row = unwrapRow(gate);
  if (Object.keys(row).length === 0) return "not run";
  const failures = readList(row.failuresJson ?? row.failures)
    .map((entry) => (isRecord(entry) ? asString(entry.check) : asString(entry)))
    .filter((entry) => entry.length > 0);
  if (rowOk(row)) return "green";
  return failures.length > 0 ? "FAILING: " + failures.join(", ") : "FAILING";
}

/** True when every selected stage lane is either approved or out of rounds. */
export function stageSettled(lanes: Array<{ settled: boolean }>): boolean {
  return lanes.length > 0 && lanes.every((lane) => lane.settled);
}

function escapeHtml(value: string): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const REPORT_STYLE = `
:root{color-scheme:light dark;--bg:#0b0d10;--fg:#e6e8eb;--muted:#9aa4b2;--line:#232935;--ok:#3fb950;--bad:#f85149;--warn:#d29922}
@media (prefers-color-scheme: light){:root{--bg:#fff;--fg:#14181f;--muted:#5a6472;--line:#e3e7ee}}
*{box-sizing:border-box}
body{margin:0;padding:2rem;background:var(--bg);color:var(--fg);font:15px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:60rem;margin:0 auto}
h1{font-size:1.6rem;margin:0 0 .25rem}
h2{font-size:1.1rem;margin:2rem 0 .5rem;border-bottom:1px solid var(--line);padding-bottom:.35rem}
p.meta{color:var(--muted);margin:0 0 1.5rem}
table{width:100%;border-collapse:collapse;margin:.5rem 0 1rem}
th,td{text-align:left;padding:.45rem .6rem;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:.82rem;text-transform:uppercase;letter-spacing:.04em}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85rem}
pre{background:rgba(127,127,127,.12);padding:.75rem;border-radius:.5rem;overflow-x:auto}
.pill{display:inline-block;padding:.1rem .5rem;border-radius:999px;font-size:.78rem;border:1px solid var(--line)}
.ok{color:var(--ok);border-color:var(--ok)}
.bad{color:var(--bad);border-color:var(--bad)}
.warn{color:var(--warn);border-color:var(--warn)}
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${REPORT_STYLE}</style>
</head><body><main>${body}</main></body></html>
`;
}

export type LaneReportInput = {
  lane: Lane;
  missionTitle: string;
  revision: number;
  phase: LanePhase;
  gateOk: boolean;
  gateDetail: string;
  implementSummary: string;
  reviewVerdict: string;
  reviewFeedback: string;
  diffStat: string;
  commitId: string;
};

/** Self-contained HTML report for one lane revision. */
export function renderLaneReportHtml(input: LaneReportInput): string {
  const { lane } = input;
  const status = input.gateOk ? "ok" : "bad";
  return page(
    lane.title + " r" + String(input.revision),
    `
<h1>${escapeHtml(lane.title)}</h1>
<p class="meta">${escapeHtml(input.missionTitle)} &middot; stage ${escapeHtml(lane.stage)} &middot;
repo <code>${escapeHtml(lane.repo)}</code> &middot; revision ${String(input.revision)} &middot;
<span class="pill ${status}">${escapeHtml(input.gateOk ? "gate green" : "gate failing")}</span>
<span class="pill">${escapeHtml(input.phase)}</span></p>
<h2>Goal</h2><p>${escapeHtml(lane.goal)}</p>
<h2>What changed</h2><p>${escapeHtml(input.implementSummary || "No summary recorded.")}</p>
${input.diffStat ? `<pre>${escapeHtml(input.diffStat)}</pre>` : ""}
<h2>Gate</h2><pre>${escapeHtml(input.gateDetail || "No gate output recorded.")}</pre>
<h2>Review</h2>
<p><span class="pill ${input.reviewVerdict === "approve" ? "ok" : "warn"}">${escapeHtml(input.reviewVerdict || "none")}</span></p>
<p>${escapeHtml(input.reviewFeedback || "No review feedback recorded.")}</p>
<h2>Scope</h2>
<table><thead><tr><th>Paths</th><th>Checks</th><th>Commit</th></tr></thead>
<tbody><tr>
<td>${lane.scopes.map((scope) => `<code>${escapeHtml(scope)}</code>`).join("<br>") || "&mdash;"}</td>
<td>${lane.checks.map((check) => `<code>${escapeHtml(check)}</code>`).join("<br>") || "&mdash;"}</td>
<td><code>${escapeHtml(input.commitId || "uncommitted")}</code></td>
</tr></tbody></table>
`,
  );
}

export type StageReportRow = {
  slug: string;
  title: string;
  repo: Repo;
  phase: LanePhase;
  gateOk: boolean;
  revision: number;
  reportPath: string;
};

/** Self-contained HTML roll-up for one stage. */
export function renderStageReportHtml(input: {
  missionTitle: string;
  stage: StageEntry;
  rows: StageReportRow[];
  integrateSummary: string;
  integrateOk: boolean;
}): string {
  const green = input.rows.filter((row) => row.gateOk).length;
  const approved = input.rows.filter((row) => row.phase === "approved").length;
  return page(
    "Stage " + input.stage.id + " report",
    `
<h1>Stage ${escapeHtml(input.stage.id)}: ${escapeHtml(input.stage.title)}</h1>
<p class="meta">${escapeHtml(input.missionTitle)} &middot; ${String(input.rows.length)} lanes &middot;
${String(green)} green &middot; ${String(approved)} approved &middot;
<span class="pill ${input.integrateOk ? "ok" : "bad"}">${escapeHtml(input.integrateOk ? "integration green" : "integration failing")}</span></p>
<h2>Goal</h2><p>${escapeHtml(input.stage.goal)}</p>
<h2>Lanes</h2>
<table><thead><tr><th>Lane</th><th>Repo</th><th>Phase</th><th>Gate</th><th>Rev</th><th>Report</th></tr></thead><tbody>
${input.rows
  .map(
    (row) => `<tr><td>${escapeHtml(row.title)}<br><code>${escapeHtml(row.slug)}</code></td>
<td><code>${escapeHtml(row.repo)}</code></td>
<td>${escapeHtml(row.phase)}</td>
<td><span class="pill ${row.gateOk ? "ok" : "bad"}">${row.gateOk ? "green" : "red"}</span></td>
<td>${String(row.revision)}</td>
<td><a href="${escapeHtml(row.reportPath)}">open</a></td></tr>`,
  )
  .join("\n")}
</tbody></table>
<h2>Integration</h2><pre>${escapeHtml(input.integrateSummary || "Not run.")}</pre>
`,
  );
}
