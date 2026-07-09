// smithers-source: authored
// smithers-display-name: Bulletproof Audit
/** @jsxImportSource smithers-orchestrator */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createSmithers, Parallel, Sequence } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import { FeatureGroups } from "../specs/features";

/**
 * Bulletproof Audit — a production-readiness scorecard for the entire Smithers
 * feature inventory.
 *
 * It loops over every feature group in `.smithers/specs/features.ts` and, for
 * each group, runs ONE grounded Codex Sol audit agent that scores the
 * group across ten production-hardening dimensions (see {@link DIMENSIONS}):
 * end-to-end test coverage, unit-test depth (error/boundary/edge cases),
 * observability, architecture quality, JSDoc coverage, human + LLM docs,
 * durability & resilience, type-safety & public-API surface, security &
 * sandboxing, and eval/scorer coverage. A report agent assembles the per-group
 * scorecards into a single ranked report (worst groups first), a deterministic
 * scorecard matrix, and a cross-repo prioritized backlog. A final DETERMINISTIC
 * compute step then writes that report to `.smithers/audits/bulletproof-audit.md`
 * — guaranteed, not dependent on the agent remembering to call a write tool.
 *
 * Fan-out is "combined per group": ~N group-audit agents (one per non-empty
 * group) + 1 report agent + 1 deterministic writer. The audit is READ-ONLY — it
 * never mutates product code; it only writes its own report file. Feed the
 * resulting backlog into the `audit-burndown` workflow to actually close gaps.
 *
 * Run:
 *   smithers up .smithers/workflows/bulletproof-audit.tsx
 *   # audit only a few groups, harsher flag threshold:
 *   smithers up .smithers/workflows/bulletproof-audit.tsx \
 *     --input '{"groups":["WORKFLOW_ENGINE","DATABASE_PERSISTENCE"],"minScoreToFlag":80}'
 *   smithers output report -r <run>     # the structured report
 *   cat .smithers/audits/bulletproof-audit.md
 */

/** A single production-readiness dimension the audit scores per feature group. */
type AuditDimension = {
  /** Stable machine key, also the scorecard column header. */
  key: string;
  /** Human title shown in the report. */
  title: string;
  /** What the auditor evaluates and what "good" looks like. */
  guidance: string;
};

/**
 * The ten dimensions every feature group is scored against. Ordered with the
 * user's six core dimensions first, then the four durable-control-plane
 * dimensions that are most load-bearing for Smithers. Extend this list to add a
 * new audit category — the prompt, scorecard matrix, and report all derive from
 * it, so nothing else needs to change.
 */
const DIMENSIONS: readonly AuditDimension[] = [
  {
    key: "e2e",
    title: "End-to-end test coverage",
    guidance:
      "Real end-to-end tests (the no-mocks `e2e/` suite, `*.e2e.test.*`) exercise this feature through the real engine/CLI/gateway against real backends. Good = happy path AND failure/fault paths are covered end-to-end, not mocked.",
  },
  {
    key: "unit",
    title: "Unit tests — errors, boundaries, edge cases",
    guidance:
      "Focused unit tests cover error conditions, boundary values, empty/null/overflow inputs, concurrency races, and edge cases — not just the happy path. Good = every branch and failure mode has a deterministic test.",
  },
  {
    key: "obs",
    title: "Observability",
    guidance:
      "Metrics, structured logs, OTLP traces/spans, and run-events make this feature debuggable in production (see `apps/observability`, Effect metrics, event emission). Good = key operations emit metrics/events with useful labels and correlation ids.",
  },
  {
    key: "arch",
    title: "Architecture & implementation quality",
    guidance:
      "Cleanly implemented and well-factored, with clear module boundaries and no needless complexity. Penalize BOTH under-engineering (fragile, tangled, copy-paste) AND over-engineering (speculative abstraction, indirection without payoff). Good = the simplest design that fully meets the need.",
  },
  {
    key: "jsdoc",
    title: "JSDoc coverage",
    guidance:
      "Exported/public symbols carry accurate JSDoc (params, returns, throws, examples). Good = a consumer understands the API from the doc comments alone, with no need to read the implementation.",
  },
  {
    key: "docs",
    title: "Documentation (human + LLM)",
    guidance:
      "Covered in human docs (`docs/`) AND/OR the generated LLM bundles (`llms.txt` / `llms-full.txt`). Good = discoverable, accurate, with usage examples; the `check-docs` / `check-llms` gates would pass for it.",
  },
  {
    key: "durability",
    title: "Durability & resilience",
    guidance:
      "Crash-safety, durable persistence, retries/backoff, idempotency, and correct replay/time-travel/resume behavior — Smithers' core promise. Good = the feature survives process death and resumes deterministically without dropping or double-applying work.",
  },
  {
    key: "types",
    title: "Type-safety & public API surface",
    guidance:
      "Strong public types, the hand-maintained `src/index.d.ts` in sync with real exports, no `any`/unsafe casts leaking to the public API, and zod schema validation at runtime boundaries. Good = misuse is a compile error and bad input is rejected at runtime.",
  },
  {
    key: "security",
    title: "Security & sandboxing",
    guidance:
      "Input validation, path/network sandboxing, auth/scope enforcement, and no injection or trust-boundary violations (agent-generated input, gateway requests, cross-origin upgrades). Good = untrusted input cannot escape its sandbox or escalate scope.",
  },
  {
    key: "evals",
    title: "Eval & scorer coverage",
    guidance:
      "Non-deterministic behavior is proven by eval suites and/or scorers (`.smithers/evals`, `packages/scorers`), not just deterministic tests. Good = regressions in agent/LLM behavior are caught by a scored, seeded eval.",
  },
] as const;

const dimensionResultSchema = z.object({
  /** Matches an {@link AuditDimension.key}. */
  key: z.string(),
  title: z.string(),
  /** 0 = absent, 100 = exemplary. */
  score: z.number().min(0).max(100),
  /** 2–5 sentences on the current state: what exists and what is missing. */
  findings: z.string(),
  /** Concrete, actionable gap items. */
  gaps: z.array(z.string()).default([]),
  /** `file:line` references the auditor actually inspected to justify the score. */
  evidence: z.array(z.string()).default([]),
});

const groupAuditSchema = z.looseObject({
  groupName: z.string(),
  /** Holistic, weighted judgment for the group (not a naive dimension average). */
  overallScore: z.number().min(0).max(100),
  /** The features in the group the auditor actually inspected. */
  featuresAudited: z.array(z.string()).default([]),
  dimensions: z.array(dimensionResultSchema).default([]),
  /** The 3–5 highest-leverage fixes for this group across all dimensions. */
  topGaps: z.array(z.string()).default([]),
  summary: z.string(),
});

const backlogItemSchema = z.object({
  title: z.string(),
  group: z.string(),
  dimension: z.string(),
  severity: z.enum(["critical", "high", "medium", "low"]),
  rationale: z.string(),
});

const reportSchema = z.object({
  totalGroups: z.number().int(),
  /** Mean of the group overall scores. */
  overallScore: z.number(),
  /** The 2–3 lowest-scoring dimensions across the whole repo. */
  weakestDimensions: z.array(z.string()).default([]),
  /** Highest-leverage fixes across the entire repo, ordered by leverage. */
  prioritizedBacklog: z.array(backlogItemSchema).default([]),
  /** The deterministic scorecard matrix (markdown table). */
  scorecardMarkdown: z.string(),
  /** The complete markdown report body — written to disk by the `write-report` step. */
  markdownBody: z.string(),
  summary: z.string(),
});

/** Result of the deterministic file-write step. */
const writeResultSchema = z.object({
  written: z.boolean(),
  /** Absolute-or-repo-relative path the report was written to ("" if skipped). */
  reportPath: z.string().default(""),
  bytes: z.number().int().default(0),
  summary: z.string().default(""),
});

const inputSchema = z.object({
  /** Restrict the audit to these feature-group names; empty = every non-empty group. */
  groups: z.array(z.string()).default([]),
  /** Extra grounding context handed to every audit agent. */
  additionalContext: z.string().nullable().default(null),
  /** How many group audits run in parallel. */
  maxConcurrency: z.number().int().default(5),
  /** Dimensions scoring below this land in the prioritized backlog. */
  minScoreToFlag: z.number().int().min(0).max(100).default(70),
  /** Write the assembled report to `reportDir/bulletproof-audit.md`. */
  writeReport: z.boolean().default(true),
  /** Directory for the written report. */
  reportDir: z.string().default(".smithers/audits"),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: inputSchema,
  groupAudit: groupAuditSchema,
  report: reportSchema,
  written: writeResultSchema,
});

type WorkItem = { groupName: string; features: string[]; sources: string };

/** kebab-case a group name into a stable node-id fragment. */
function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "group";
}

/**
 * Parse the `// Source: …` comment that sits immediately above each feature
 * group in `features.ts`, so each audit agent knows exactly where that group's
 * code lives. Comments are stripped from the imported module, so we read the
 * spec's text directly. Returns `groupName -> source-locations` (empty when a
 * group has no source comment).
 */
function parseGroupSources(specText: string, groupNames: string[]): Record<string, string> {
  const lines = specText.split("\n");
  const map: Record<string, string> = {};
  for (const name of groupNames) {
    const idx = lines.findIndex((line) => new RegExp(`^\\s*${name}:\\s*\\[`).test(line));
    let src = "";
    for (let i = idx - 1; idx !== -1 && i >= 0 && i >= idx - 4; i--) {
      const m = (lines[i] ?? "").match(/^\s*\/\/\s*Source:\s*(.*)$/);
      if (m) {
        src = m[1].trim();
        break;
      }
    }
    map[name] = src;
  }
  return map;
}

// Read the spec's source-location comments once at module load. Resolved
// relative to THIS file (not cwd) so it works wherever `smithers up` runs from.
const GROUP_SOURCES: Record<string, string> = (() => {
  try {
    const specPath = fileURLToPath(new URL("../specs/features.ts", import.meta.url));
    return parseGroupSources(readFileSync(specPath, "utf8"), Object.keys(FeatureGroups));
  } catch {
    return {};
  }
})();

/** Build the grounded per-group audit prompt. */
function auditPrompt(item: WorkItem, additionalContext: string | null): string {
  return [
    `You are performing a PRODUCTION-READINESS AUDIT of ONE feature group in the Smithers codebase.`,
    `Ground EVERY judgment in the actual repository — read the source, tests, docs, and eval files.`,
    `Do not speculate: anything you cannot verify in the repo must pull the score DOWN, not up.`,
    ``,
    `FEATURE GROUP: ${item.groupName}`,
    item.sources ? `SOURCE LOCATIONS (where this group's code lives — start here): ${item.sources}` : ``,
    ``,
    `FEATURES IN THIS GROUP (${item.features.length}):`,
    item.features.map((f) => `- ${f}`).join("\n"),
    ``,
    `This group may be large. You need not inspect every feature equally: identify the highest-risk /`,
    `most important features, read their implementation + tests + docs + evals, and let those ground`,
    `your scores. List the features you actually audited in \`featuresAudited\`.`,
    ``,
    `Score EACH dimension below from 0–100 (0 = absent, 100 = exemplary). For each dimension provide:`,
    `- \`findings\`: 2–5 sentences on the current state — what exists and what is missing.`,
    `- \`gaps\`: concrete, actionable items (e.g. "add e2e test for resume-after-crash in <file>").`,
    `- \`evidence\`: real \`file:line\` references you inspected that justify the score.`,
    ``,
    `DIMENSIONS:`,
    DIMENSIONS.map((d) => `- [${d.key}] ${d.title} — ${d.guidance}`).join("\n"),
    ``,
    `Scoring guidance:`,
    `- Be a harsh, specific auditor. 100 means comprehensive, evidenced coverage.`,
    `- \`overallScore\` is your holistic, weighted judgment for the group — NOT a naive average.`,
    `- \`topGaps\` = the 3–5 highest-leverage fixes across all dimensions for this group.`,
    additionalContext ? `\nADDITIONAL CONTEXT:\n${additionalContext}` : ``,
    ``,
    `Output the required JSON. Use the repository as the source of truth.`,
  ]
    .filter((line) => line !== ``)
    .join("\n");
}

/** Build the deterministic scorecard matrix (worst groups first) from structured results. */
function buildScorecardTable(results: Array<z.infer<typeof groupAuditSchema>>): string {
  const header = `| Group | Overall | ${DIMENSIONS.map((d) => d.key).join(" | ")} |`;
  const divider = `| --- | --- | ${DIMENSIONS.map(() => "---").join(" | ")} |`;
  const rows = [...results]
    .sort((a, b) => (a.overallScore ?? 0) - (b.overallScore ?? 0))
    .map((r) => {
      const byKey = new Map((r.dimensions ?? []).map((d) => [d.key, d.score]));
      const cells = DIMENSIONS.map((d) => {
        const v = byKey.get(d.key);
        return typeof v === "number" ? String(Math.round(v)) : "–";
      });
      return `| ${r.groupName} | ${Math.round(r.overallScore ?? 0)} | ${cells.join(" | ")} |`;
    });
  return [header, divider, ...rows].join("\n");
}

/** Build the final report/synthesis prompt from the per-group scorecards. */
function reportPrompt(
  results: Array<z.infer<typeof groupAuditSchema>>,
  opts: { minScoreToFlag: number },
): string {
  const table = buildScorecardTable(results);
  const detail = results
    .map((r) =>
      [
        `## ${r.groupName} (overall ${Math.round(r.overallScore ?? 0)})`,
        r.summary ?? "",
        (r.topGaps ?? []).length ? `Top gaps:\n${r.topGaps.map((g) => `- ${g}`).join("\n")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");

  return [
    `You are assembling the final Smithers BULLETPROOF AUDIT report from ${results.length} per-group scorecards.`,
    ``,
    `AUTHORITATIVE SCORECARD — computed deterministically from structured data. Include this table`,
    `VERBATIM in the report; do NOT alter any number. Set \`scorecardMarkdown\` to exactly this table:`,
    ``,
    table,
    ``,
    `PER-GROUP DETAIL:`,
    ``,
    detail,
    ``,
    `Produce a markdown report with these sections, in order:`,
    `1. Executive summary — the overall production-readiness of the codebase (1–2 paragraphs).`,
    `2. Cross-cutting themes — systemic weaknesses that recur across groups (e.g. "observability is`,
    `   consistently the weakest dimension"). Name the offending dimensions.`,
    `3. The verbatim scorecard table above.`,
    `4. Prioritized backlog — the highest-leverage fixes across the WHOLE repo. Draw from the per-group`,
    `   gaps; include any dimension scoring below ${opts.minScoreToFlag}. Each item: title, group,`,
    `   dimension, severity (critical/high/medium/low), one-line rationale. Order by leverage.`,
    ``,
    `Also set in your JSON output: \`overallScore\` = mean of group overalls; \`weakestDimensions\` =`,
    `the 2–3 lowest-scoring dimensions across all groups; \`prioritizedBacklog\` = the structured backlog;`,
    `\`scorecardMarkdown\` = the verbatim table above; \`markdownBody\` = the FULL report (all four sections).`,
    ``,
    `Do NOT write any files — a deterministic downstream step persists \`markdownBody\` to disk. Your job`,
    `is to return complete, accurate JSON. Make \`markdownBody\` the entire report, ready to save as-is.`,
  ].join("\n");
}

export default smithers((ctx) => {
  const filter = ctx.input.groups ?? [];
  const maxConcurrency = ctx.input.maxConcurrency ?? 5;
  const minScoreToFlag = ctx.input.minScoreToFlag ?? 70;
  const writeReport = ctx.input.writeReport ?? true;
  const reportDir = ctx.input.reportDir ?? ".smithers/audits";
  const reportPath = `${reportDir.replace(/\/+$/, "")}/bulletproof-audit.md`;

  // Loop the code-backed feature inventory; skip empty groups (e.g. IDE_INTEGRATION).
  const workItems: WorkItem[] = Object.entries(FeatureGroups)
    .filter(([, features]) => Array.isArray(features) && features.length > 0)
    .filter(([name]) => filter.length === 0 || filter.includes(name))
    .map(([groupName, features]) => ({
      groupName,
      features: [...features],
      sources: GROUP_SOURCES[groupName] ?? "",
    }));

  // Wire every group audit into the report task's typed deps so it waits for all
  // of them and receives the structured scorecards.
  const reportNeeds: Record<string, string> = Object.fromEntries(
    workItems.map((item, i) => [`g${i}`, `audit:${slug(item.groupName)}`]),
  );
  const reportDeps = Object.fromEntries(
    workItems.map((_, i) => [`g${i}`, groupAuditSchema]),
  ) as Record<string, typeof groupAuditSchema>;

  // Sol owns the audit and report synthesis. The generated role pool is
  // Codex-only when available and exposes legacy providers only as fallback.
  const auditAgent = agents.review;
  const reportAgent = agents.review;

  return (
    <Workflow name="bulletproof-audit">
      <Sequence>
        {/* 1. AUDIT — one grounded Codex agent per feature group scores all ten dimensions. */}
        <Parallel maxConcurrency={maxConcurrency}>
          {workItems.map((item) => (
            <Task
              key={item.groupName}
              id={`audit:${slug(item.groupName)}`}
              output={outputs.groupAudit}
              agent={auditAgent}
              continueOnFail
            >
              {auditPrompt(item, ctx.input.additionalContext)}
            </Task>
          ))}
        </Parallel>

        {/* 2. REPORT — synthesize the per-group scorecards into one ranked report + backlog. */}
        <Task
          id="report"
          output={outputs.report}
          agent={reportAgent}
          needs={reportNeeds}
          deps={reportDeps}
        >
          {(deps) => {
            const results = workItems
              .map((_, i) => deps[`g${i}`])
              .filter((r): r is z.infer<typeof groupAuditSchema> => r != null);
            return reportPrompt(results, { minScoreToFlag });
          }}
        </Task>

        {/* 3. WRITE — deterministically persist the report to disk. Reads the report
            output live at execution time and writes it; no agent involved, so the
            file is guaranteed whenever the report task produced a body. */}
        {writeReport ? (
          <Task id="write-report" output={outputs.written} dependsOn={["report"]}>
            {() => {
              const report = ctx.outputMaybe(outputs.report, { nodeId: "report" });
              const body = report?.markdownBody ?? "";
              if (!body) {
                return { written: false, reportPath: "", bytes: 0, summary: "No report body to write." };
              }
              mkdirSync(dirname(reportPath), { recursive: true });
              writeFileSync(reportPath, body, "utf8");
              return {
                written: true,
                reportPath,
                bytes: Buffer.byteLength(body, "utf8"),
                summary: `Wrote ${Buffer.byteLength(body, "utf8")} bytes to ${reportPath}`,
              };
            }}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
