// smithers-source: authored
// smithers-display-name: Review Since Publish
/** @jsxImportSource smithers-orchestrator */
import { UI } from "smithers-orchestrator";
import { createSmithers, Loop, OpenCodeAgent, Parallel, Sequence, Task } from "smithers-orchestrator";
import { z } from "zod/v4";
import { providers } from "../agents";
import { baselineBriefing, resolvePublishBaseline, type PublishBaseline } from "../lib/publishBaseline";

/**
 * Review Since Publish — a three-model review panel over everything that
 * changed since the last npm publish, merged by one arbiter, fixed in parallel,
 * then re-reviewed until the panel finds nothing.
 *
 * Round shape (repeats until clean or maxRounds):
 *   1. baseline (compute, once) — ask npm for the live version, resolve its
 *      `v<version>` tag in this checkout, and capture the diff surface.
 *   2. panel (parallel) — codex/sol, kimi k3 (via OpenCode), and Claude Code
 *      fable each review the SAME surface independently.
 *   3. merge (fable) — dedupes/arbitrates the three reviews into one issue list.
 *   4. fix (parallel, codex/sol) — issues are partitioned into file-disjoint
 *      lanes so concurrent fixers never touch the same file.
 *
 * Fixes land in the working tree, and the baseline diff is `git diff <tag>`
 * (tag → working tree), so round N+1 reviews the fixes too.
 */

const severity = z.enum(["critical", "high", "medium", "low"]);

const issueSchema = z.object({
  title: z.string().trim().min(1),
  severity,
  file: z.string().trim().default(""),
  line: z.number().int().nullable().default(null),
  detail: z.string().trim().min(1),
  suggestedFix: z.string().trim().default(""),
});

const reviewSchema = z.object({
  reviewer: z.string().trim().default(""),
  summary: z.string().trim().default(""),
  issues: z.array(issueSchema).max(200).default([]),
});

const mergedIssueSchema = issueSchema.extend({
  id: z.string().trim().min(1),
  files: z.array(z.string().trim().min(1)).default([]),
  raisedBy: z.array(z.string().trim().min(1)).default([]),
});

const mergedSchema = z.object({
  summary: z.string().trim().default(""),
  /** True only when the panel found nothing real that still needs fixing. */
  clean: z.boolean().default(false),
  issues: z.array(mergedIssueSchema).max(200).default([]),
  dismissed: z
    .array(z.object({ title: z.string(), reason: z.string() }))
    .max(200)
    .default([]),
});

const fixSchema = z.object({
  lane: z.string().trim().default(""),
  summary: z.string().trim().default(""),
  fixed: z.array(z.string()).default([]),
  skipped: z.array(z.object({ id: z.string(), reason: z.string() })).default([]),
});

const baselineSchema = z.object({
  packageName: z.string(),
  publishedVersion: z.string(),
  tag: z.string(),
  tagCommit: z.string(),
  head: z.string(),
  commitCount: z.number(),
  diffStat: z.string(),
  changedFiles: z.array(z.string()),
  untrackedFiles: z.array(z.string()),
  commits: z.array(z.string()),
  notes: z.array(z.string()),
  briefing: z.string(),
});

export const inputSchema = z.object({
  packageName: z.string().trim().min(1).default("smithers-orchestrator"),
  repoRoot: z.string().trim().min(1).default(process.cwd()),
  /** Skip the npm lookup and pin the baseline tag by hand. */
  tag: z.string().trim().default(""),
  maxRounds: z.number().int().min(1).max(10).default(5),
  /**
   * Split the changed-file surface into N slices and give every panelist one
   * task per slice. 1 = each panelist reviews everything in one pass; raise it
   * when the diff is too large for a single agent context to cover honestly.
   */
  reviewShards: z.number().int().min(1).max(12).default(1),
  maxFixLanes: z.number().int().min(1).max(8).default(4),
  /** Severities worth fixing; anything below is reported but not gated on. */
  fixSeverities: z.array(severity).default(["critical", "high", "medium"]),
  /**
   * Heartbeat budget for reviewer/fixer tasks; 6h, i.e. effectively no timeout.
   *
   * The engine's 10m default assumes a chatty agent. A reviewer deep-reading a
   * few hundred files, or a fixer running a test suite, is legitimately silent
   * far longer, and the watchdog then kills healthy work mid-read and restarts
   * the whole task from scratch (observed: three reviewers lost ~35m each).
   *
   * The watchdog cannot be switched off: `parseHeartbeatTimeoutMs` maps any
   * non-positive value to null and an agent task falls back to the 10m default
   * (packages/graph/src/extract.js), so a large ceiling is the only opt-out.
   */
  agentTimeoutMs: z
    .number()
    .int()
    .min(60_000)
    .max(12 * 60 * 60_000)
    .default(6 * 60 * 60_000),
});

const { Workflow, smithers, outputs } = createSmithers({
  input: inputSchema,
  baseline: baselineSchema,
  review: reviewSchema,
  merged: mergedSchema,
  fix: fixSchema,
});

type Baseline = z.infer<typeof baselineSchema>;
type Merged = z.infer<typeof mergedSchema>;
type MergedIssue = z.infer<typeof mergedIssueSchema>;

/** kimi k3 is served through OpenCode's kimi-for-coding provider. */
const kimiK3 = new OpenCodeAgent({ model: "kimi-for-coding/k3" });

const PANEL = [
  { key: "sol", label: "codex / gpt-5.6-sol", agent: providers.codexSol },
  { key: "kimi", label: "kimi k3 (opencode)", agent: kimiK3 },
  { key: "fable", label: "claude code / fable", agent: providers.claude },
] as const;

function reviewPrompt(opts: {
  label: string;
  briefing: string;
  round: number;
  priorSummary: string;
  shard?: { index: number; total: number; files: string[] };
}): string {
  const shardBlock =
    opts.shard && opts.shard.total > 1
      ? `\n\nYOUR SLICE (${opts.shard.index + 1} of ${opts.shard.total}) — review ONLY these files; other reviewers cover the rest:\n\`\`\`\n${opts.shard.files.join("\n")}\n\`\`\`\n`
      : "";
  return `You are **${opts.label}**, one of three independent reviewers on a release review panel.

Review EVERY change made since the last npm publish and report real defects.

${opts.briefing}${shardBlock}

How to read the changes (run these yourself; do not guess):
- \`git diff TAG\` (substitute the real tag) compares the last published tag against the CURRENT WORKING TREE, so it includes uncommitted work. Use the tag from the briefing above.
- \`git diff TAG -- path/to/file\` to go file by file, \`git log --oneline TAG..HEAD\` for commit context.
- Read the surrounding code, not just the hunk. A hunk that looks fine can break its caller.

Round ${opts.round}.${
    opts.priorSummary
      ? ` Previous rounds already produced fixes — review the CURRENT state of the diff, including those fixes (they can introduce new defects). Prior round summary:\n${opts.priorSummary}`
      : ""
  }

What counts as an issue:
- correctness bugs, regressions, broken/missing error handling, race conditions, resource leaks
- security problems, injected secrets, unsafe shell/SQL/path handling
- API/type/export drift, docs bundles out of sync with the code they document
- missing or wrong tests for behavior the diff introduces
- data loss / destructive operations without guards

What does NOT count: style preferences, speculative refactors, "could be faster" without evidence, or anything you cannot point to a concrete failure for.

Be specific and falsifiable. Every issue needs a file, ideally a line, and a concrete failure scenario in \`detail\`. Do not report an issue you have not verified by reading the code. It is correct and expected to return an EMPTY issue list when the diff is clean — do not invent work.

Return: \`reviewer\` (your label), a short \`summary\`, and \`issues\`.`;
}

function mergePrompt(opts: {
  briefing: string;
  round: number;
  reviews: { reviewer: string; summary: string; issues: unknown[] }[];
}): string {
  return `You are the arbiter of a three-model release review panel (codex/sol, kimi k3, claude fable).

Merge their three independent reviews of everything changed since the last publish into ONE authoritative issue list.

${opts.briefing}

Round ${opts.round}. The three raw reviews:

\`\`\`json
${JSON.stringify(opts.reviews, null, 2)}
\`\`\`

Your job:
1. **Verify before you keep.** Open the cited code for each claimed issue. Reviewers hallucinate; a claim you cannot confirm in the actual diff goes in \`dismissed\` with the reason, not in \`issues\`.
2. **Deduplicate.** The same defect reported by two or three panelists is ONE issue; record every reporter in \`raisedBy\` (a defect all three found is high-confidence).
3. **Normalize severity** across reviewers so the scale means the same thing.
4. **Assign a stable \`id\`** per issue: \`R${opts.round}-001\`, \`R${opts.round}-002\`, ...
5. **List \`files\`** — every implementation AND test file that must be edited to fix it. This drives parallel fix lanes, so be accurate and complete; a missing file causes two fixers to collide.
6. Order \`issues\` most severe first.
7. Set \`clean: true\` ONLY when no verified issue survives. An empty \`issues\` list with \`clean: false\` is a contradiction.

Do not fix anything yourself. Merge and verify only.`;
}

function fixPrompt(opts: { lane: string; round: number; issues: MergedIssue[]; files: string[] }): string {
  return `You are a fixer on lane **${opts.lane}** of a release-review fix train (round ${opts.round}).

Fix these verified issues. Other fixers are working in parallel on OTHER files right now.

\`\`\`json
${JSON.stringify(opts.issues, null, 2)}
\`\`\`

NEVER EDIT THE RUNNING WORKFLOW. \`.smithers/workflows/review-since-publish.tsx\`,
\`.smithers/ui/review-since-publish.tsx\`, \`.smithers/lib/publishBaseline.ts\`, and
\`.smithers/tests/review-since-publish.test.tsx\` are the workflow executing you
right now; the engine re-reads them every frame, so editing them mid-run
clobbers live configuration and corrupts the run. If an issue targets one of
them, record it in \`skipped\` — a human applies it between runs.

HARD BOUNDARY — you may only edit these files:
${opts.files.map((f) => `- ${f}`).join("\n")}

Test files are not an exception: the arbiter must list every covering test file
so it participates in lane partitioning. If a correct fix requires touching a
file outside that list, do NOT touch it: skip the issue and record it in
\`skipped\` with the reason and the file you would need. It will be picked up
next round.

Rules:
- Fix the root cause, not the symptom.
- Add or update a test that fails before your fix and passes after, whenever the issue is testable.
- Run the narrowest relevant checks (\`pnpm -C packages/PACKAGE test\`, \`pnpm typecheck\`) for what you touched.
- Do not commit, do not push, do not rebase. Leave the work in the working tree.
- Do not "fix" by deleting tests, weakening assertions, or silencing errors.

Return \`lane\`, a \`summary\` of what you changed, \`fixed\` (issue ids you actually fixed), and \`skipped\`.`;
}

/**
 * Partition issues into file-disjoint lanes: group by file set first, then
 * round-robin the groups so no two concurrent fixers can edit the same file.
 */
function planLanes(
  issues: MergedIssue[],
  maxLanes: number,
): { lane: string; issues: MergedIssue[]; files: string[] }[] {
  const byFile = new Map<string, MergedIssue[]>();
  for (const issue of issues) {
    const files = (issue.files?.length ? issue.files : [issue.file]).filter(Boolean);
    const key = files.length ? [...new Set(files)].sort().join("|") : `__unfiled__:${issue.id}`;
    const bucket = byFile.get(key);
    if (bucket) bucket.push(issue);
    else byFile.set(key, [issue]);
  }

  // Merge any groups that share a file — overlapping groups must be one lane.
  const groups: { files: Set<string>; issues: MergedIssue[] }[] = [];
  for (const [key, groupIssues] of byFile) {
    const files = new Set(key.startsWith("__unfiled__:") ? [] : key.split("|"));
    const overlapping = groups.filter((g) => [...files].some((f) => g.files.has(f)));
    if (overlapping.length === 0) {
      groups.push({ files, issues: [...groupIssues] });
      continue;
    }
    const [target, ...rest] = overlapping;
    for (const f of files) target.files.add(f);
    target.issues.push(...groupIssues);
    for (const other of rest) {
      for (const f of other.files) target.files.add(f);
      target.issues.push(...other.issues);
      groups.splice(groups.indexOf(other), 1);
    }
  }

  groups.sort((a, b) => b.issues.length - a.issues.length);
  const laneCount = Math.max(1, Math.min(maxLanes, groups.length));
  const lanes = Array.from({ length: laneCount }, (_, i) => ({
    lane: `lane-${i + 1}`,
    issues: [] as MergedIssue[],
    files: [] as string[],
  }));
  groups.forEach((group, i) => {
    const lane = lanes[i % laneCount];
    lane.issues.push(...group.issues);
    lane.files.push(...group.files);
  });
  return lanes.map((l) => ({ ...l, files: [...new Set(l.files)].sort() })).filter((l) => l.issues.length > 0);
}

export default smithers((ctx) => {
  const maxRounds = ctx.input.maxRounds ?? 5;
  const maxFixLanes = ctx.input.maxFixLanes ?? 4;
  const fixSeverities = new Set(ctx.input.fixSeverities ?? ["critical", "high", "medium"]);

  const baseline = (ctx.outputs.baseline ?? []).at(-1) as Baseline | undefined;
  const merges = (ctx.outputs.merged ?? []) as Merged[];
  const latestMerge = merges.at(-1);
  const round = merges.length + 1;

  const actionable = (latestMerge?.issues ?? []).filter((i) => fixSeverities.has(i.severity));
  const clean = latestMerge ? latestMerge.clean === true || actionable.length === 0 : false;
  const lanes = clean ? [] : planLanes(actionable, maxFixLanes);

  const briefing = baseline?.briefing ?? "";
  const priorSummary = merges.map((m, i) => `- round ${i + 1}: ${m.issues.length} issue(s) — ${m.summary}`).join("\n");

  const agentTimeoutMs = ctx.input.agentTimeoutMs ?? 6 * 60 * 60_000;
  const shardCount = Math.max(1, ctx.input.reviewShards ?? 1);
  const changed = [...new Set([...(baseline?.changedFiles ?? []), ...(baseline?.untrackedFiles ?? [])])];
  const shards = Array.from({ length: shardCount }, (_, index) => ({
    index,
    total: shardCount,
    files: changed.filter((_, i) => i % shardCount === index),
  }));

  const reviews = (ctx.outputs.review ?? []).slice(-(PANEL.length * shardCount)).map((r) => ({
    reviewer: r.reviewer,
    summary: r.summary,
    issues: r.issues,
  }));

  return (
    <Workflow name="review-since-publish">
      <UI entry="../ui/review-since-publish.tsx" title="Review Since Publish" />
      <Sequence>
        <Task id="baseline" output={outputs.baseline}>
          {async () => {
            const resolved: PublishBaseline = await resolvePublishBaseline({
              repoRoot: ctx.input.repoRoot,
              packageName: ctx.input.packageName,
              tagOverride: ctx.input.tag || undefined,
            });
            return { ...resolved, briefing: baselineBriefing(resolved) };
          }}
        </Task>

        <Loop id="review-fix" until={clean} maxIterations={maxRounds}>
          <Sequence>
            <Parallel>
              {PANEL.flatMap((member) =>
                shards.map((shard) => {
                  const nodeId = shardCount > 1 ? `review:${member.key}:${shard.index}` : `review:${member.key}`;
                  return (
                    <Task
                      key={nodeId}
                      id={nodeId}
                      output={outputs.review}
                      agent={member.agent}
                      heartbeatTimeoutMs={agentTimeoutMs}
                    >
                      {reviewPrompt({ label: member.label, briefing, round, priorSummary, shard })}
                    </Task>
                  );
                }),
              )}
            </Parallel>

            <Task id="merge" output={outputs.merged} agent={providers.claude} heartbeatTimeoutMs={agentTimeoutMs}>
              {mergePrompt({ briefing, round, reviews })}
            </Task>

            {lanes.length > 0 ? (
              <Parallel>
                {lanes.map((lane) => (
                  <Task
                    key={lane.lane}
                    id={`fix:${lane.lane}`}
                    output={outputs.fix}
                    agent={providers.codexSol}
                    heartbeatTimeoutMs={agentTimeoutMs}
                  >
                    {fixPrompt({ lane: lane.lane, round, issues: lane.issues, files: lane.files })}
                  </Task>
                ))}
              </Parallel>
            ) : null}
          </Sequence>
        </Loop>
      </Sequence>
    </Workflow>
  );
});
