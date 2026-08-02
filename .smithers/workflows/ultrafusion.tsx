/** @jsxImportSource smthrs */
/**
 * Ultrafusion — N diverse agents do the same task blind, a fusion agent merges
 * the best of all of them, and every lane is scored by how the fusion judged
 * its contributions.
 *
 * The pattern (generalized from the Operation Ferric round-4 bake-off):
 *   frame (fusion agent writes the lane brief + deliverable contract)
 *     → 4 parallel LANES, one isolated <Worktree> each, IDENTICAL brief,
 *       anonymized as A/B/C/D (permutation derived from the runId)
 *     → FUSION: the main agent (default Fable) merges the best of all lanes.
 *       BLIND: the fusion prompt contains only anonymized lane content; lane
 *       reports are instructed not to self-identify; the letter→model roster
 *       is persisted only AFTER fusion completes.
 *     → SCORING: per lane, from the fusion's adjudication of each discrete
 *       finding — unique-accepted +3, shared-accepted +1, rejected-weak −1,
 *       rejected-wrong −3.
 *     → artifact assembly (fused report + scores.json on disk), last output.
 *
 * Input: { prompt (the task), slug?, laneTimeoutHours?, fusionModel? }.
 * Lanes: OpenCode/Kimi-K3, Claude Fable, Claude Opus, Codex Sol.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createSmithers,
  ClaudeCodeAgent,
  CodexAgent,
  OpenCodeAgent,
  Sequence,
  Parallel,
  Worktree,
  Aspects,
  UI,
} from "smthrs";
import { z } from "zod";

/* ────────────────────────────── schemas ──────────────────────────────── */

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: z.object({
    prompt: z.string().nullish(), // the task every lane performs
    slug: z.string().nullish(), // artifact/worktree naming
    laneTimeoutHours: z.number().int().nullish(), // default 5, max 8
    fusionModel: z.string().nullish(), // default claude-fable-5
  }),
  ufBrief: z.object({
    briefMarkdown: z.string().min(300), // the normalized lane brief
    deliverableSpec: z.string().min(150), // exact deliverable + findings contract
  }),
  ufLane: z.object({
    laneId: z.string().min(1), // anonymous letter A–D
    reportPath: z.string().min(4), // full report.md inside the lane worktree
    summaryMarkdown: z.string().min(200), // executive summary (fusion reads this first)
    findings: z.string().min(2), // JSON [{id,title,claim,severity,area}]
  }),
  ufFusion: z.object({
    fusedPath: z.string().min(4),
    adjudicationsPath: z.string().min(4).nullish(), // written to disk by the fusion agent
    adjudications: z.string().nullish(), // legacy inline shape; scoring accepts either
    headline: z.string().min(120), // short verdict; the full report lives on disk
  }),
  ufRoster: z.object({ mapping: z.string().min(2) }), // JSON letter→{agentKey,model}; written after fusion
  ufScore: z.object({
    laneId: z.string().min(1),
    agentKey: z.string().min(2),
    model: z.string().min(2),
    uniqueAccepted: z.number().int(),
    sharedAccepted: z.number().int(),
    rejectedWeak: z.number().int(),
    rejectedWrong: z.number().int(),
    points: z.number().int(),
    verdictNote: z.string().min(5),
  }),
  ufArtifact: z.object({
    dir: z.string().min(4),
    fusedPath: z.string().min(4),
    ranking: z.string().min(2), // human-readable leaderboard
  }),
});

/* ────────────────────────────── agents ───────────────────────────────── */
// All lanes need autonomous-run flags or a detached run stalls at the first
// tool call. Escalation/identity notes stay OUT of lane prompts (blind fusion).

/**
 * Claude CLI agents must NOT inherit ANTHROPIC_API_KEY. When that variable is
 * set it takes precedence over the claude.ai subscription login, so an exhausted
 * API credit balance fails every Claude lane with `out_of_credits` while the
 * subscription sits unused. Blanking it here makes the workflow immune to
 * whatever the launching shell happens to export. (Cost two rounds to learn.)
 */
const CLAUDE_ENV = { ANTHROPIC_API_KEY: "" };

const LANES: Array<{ key: string; model: string; agent: any }> = [
  {
    key: "kimi-opencode",
    model: "kimi-for-coding/k3-256k",
    agent: new OpenCodeAgent({ model: "kimi-for-coding/k3-256k", yolo: true }),
  },
  {
    key: "claude-fable",
    model: "claude-fable-5",
    agent: new ClaudeCodeAgent({
      model: "claude-fable-5",
      permissionMode: "bypassPermissions",
      dangerouslySkipPermissions: true,
      env: CLAUDE_ENV,
    }),
  },
  {
    key: "claude-opus",
    model: "claude-opus-4-8",
    agent: new ClaudeCodeAgent({
      model: "claude-opus-4-8",
      permissionMode: "bypassPermissions",
      dangerouslySkipPermissions: true,
      env: CLAUDE_ENV,
    }),
  },
  {
    key: "codex-sol",
    model: "gpt-5.6-sol",
    agent: new CodexAgent({
      model: "gpt-5.6-sol",
      sandbox: "danger-full-access",
      dangerouslyBypassApprovalsAndSandbox: true,
      skipGitRepoCheck: true,
    }),
  },
];
const LETTERS = ["A", "B", "C", "D"] as const;

/**
 * Worktree root, resolved through symlinks. On macOS `/tmp` is a symlink to
 * `/private/tmp`: a jj workspace created under the symlinked path fails
 * smithers' worktree root check (git resolves `/private/tmp/…` while the check
 * compares `/tmp/…`) with WORKTREE_CREATE_FAILED. `os.tmpdir()` avoids that but
 * points at the per-user `/var/folders/…` dir macOS periodically reaps, which a
 * multi-hour lane cannot rely on. Resolve `/tmp` itself: stable on both.
 */
const TMP_ROOT = (() => {
  try {
    return realpathSync("/tmp");
  } catch {
    return realpathSync(tmpdir());
  }
})();

function fusionAgentFor(model: string) {
  return new ClaudeCodeAgent({
    model,
    permissionMode: "bypassPermissions",
    dangerouslySkipPermissions: true,
    env: CLAUDE_ENV,
  });
}

/* ────────────────────────────── helpers ──────────────────────────────── */

function cfg(ctx: any) {
  const prompt = ctx.input?.prompt ?? "";
  if (prompt.trim().length < 20) {
    throw new Error('ULTRAFUSION_NO_PROMPT: pass the task via --input \'{"prompt":"..."}\' (≥20 chars).');
  }
  const slug = (ctx.input?.slug ?? "task").replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 40);
  const hours = Math.min(8, Math.max(1, ctx.input?.laneTimeoutHours ?? 5));
  return {
    prompt,
    slug,
    laneTimeoutMs: hours * 3_600_000,
    fusionModel: ctx.input?.fusionModel ?? "claude-fable-5",
    // Stable within the run (and across resume); varies across runs.
    // realpath the tmp base: on macOS /tmp is a symlink to /private/tmp, and a
    // jj workspace created under the symlinked path fails smithers' worktree
    // root check (git resolves /private/tmp/..., the check compares /tmp/...)
    // with WORKTREE_CREATE_FAILED. Pass the resolved path so both agree.
    dir: join(
      TMP_ROOT,
      "ultrafusion",
      `${slug}-${String(ctx.runId)
        .replace(/[^a-zA-Z0-9]/g, "")
        .slice(-8)}`,
    ),
  };
}

/** Deterministic letter→lane permutation from the runId: blind assignment that
 *  is stable across resume but varies run to run (defeats positional habits). */
function permutation(runId: string): number[] {
  let h = 0;
  for (const ch of String(runId)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const idx = [0, 1, 2, 3];
  for (let i = idx.length - 1; i > 0; i--) {
    h = (h * 1103515245 + 12345) >>> 0;
    const j = h % (i + 1);
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx;
}

/** Adjudications live on disk: too large to pass through a structured output. */
const readAdjudications = (row: any): any[] => {
  // Prefer the on-disk file (current shape). Fall back to an inline field so a
  // run whose fusion completed under the older schema still scores correctly —
  // a mid-run schema change once zeroed a whole leaderboard this way.
  const path = row?.adjudicationsPath;
  if (typeof path === "string" && path.length > 0) {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      /* fall through to the inline field */
    }
  }
  const inline = row?.adjudications;
  if (typeof inline === "string" && inline.length > 1) {
    try {
      return JSON.parse(inline);
    } catch {
      return [];
    }
  }
  return Array.isArray(inline) ? inline : [];
};

const parseJson = (s: unknown, fallback: any) => {
  try {
    return typeof s === "string" ? JSON.parse(s) : (s ?? fallback);
  } catch {
    return fallback;
  }
};

const NO_IDENTITY =
  "Anonymity contract: your report will be judged blind against other anonymous lanes. " +
  "Do NOT identify your model, vendor, product name, or tooling anywhere in your output " +
  "or files. Refer to yourself only as your lane letter.";

/* ────────────────────────────── workflow ─────────────────────────────── */

export default smithers((ctx) => {
  const c = cfg(ctx);
  const perm = permutation(ctx.runId);
  const fusion = fusionAgentFor(c.fusionModel);
  const brief = ctx.outputMaybe(outputs.ufBrief, { nodeId: "frame" });
  const laneRows = LETTERS.map((L) => ctx.outputMaybe(outputs.ufLane, { nodeId: `lane-${L}` })).filter(
    Boolean,
  ) as any[];
  const fusionRow = ctx.outputMaybe(outputs.ufFusion, { nodeId: "fusion" });
  const roster = ctx.outputMaybe(outputs.ufRoster, { nodeId: "roster" });

  return (
    <Workflow name="ultrafusion">
      <UI entry="../ui/ultrafusion.tsx" />
      <Aspects tokenBudget={{ max: 80_000_000, onExceeded: "warn" }}>
        <Sequence>
          {/* 1 · Frame: the fusion agent normalizes the raw prompt into one
                 identical lane brief + a findings contract that makes four
                 independent outputs comparable and adjudicable. */}
          <Task id="frame" output={outputs.ufBrief} agent={fusion} timeoutMs={1_800_000}>
            {`You are framing a blind multi-agent "Ultrafusion" round. Turn the task below into
(1) briefMarkdown — the complete, self-contained brief every lane executes IDENTICALLY (keep every
requirement of the task; do not narrow scope), and
(2) deliverableSpec — the exact deliverable contract: each lane writes report.md at the root of its
own worktree (plus any poc/ subfolder work it builds), and returns a summary plus 8–25 DISCRETE
findings as JSON [{id, title, claim, severity: "critical"|"major"|"minor"|"info", area}] where each
finding is a single verifiable claim (one idea per finding — they will be individually accepted or
rejected by a blind judge). Include the anonymity rule: lanes must not identify their model or vendor.

THE TASK:
${c.prompt}`}
          </Task>

          {/* 2 · Four blind lanes, one isolated worktree each. */}
          {brief ? (
            <Parallel id="lanes" subtreeConcurrency={4}>
              {LETTERS.map((L, i) => {
                const lane = LANES[perm[i]];
                return (
                  <Worktree
                    key={L}
                    id={`wt-${L}`}
                    path={`${c.dir}/lane-${L}`}
                    branch={`uf/${c.slug}-${L}`}
                    baseBranch="main"
                  >
                    <Task
                      id={`lane-${L}`}
                      output={outputs.ufLane}
                      agent={lane.agent}
                      continueOnFail
                      timeoutMs={c.laneTimeoutMs}
                    >
                      {`You are lane ${L} of an Ultrafusion round. Work INDEPENDENTLY in this worktree (your cwd).
You may spawn subagents, build proof-of-concepts under poc/, and take the time the task deserves.
Do not read other lanes' directories. ${NO_IDENTITY}

${brief.briefMarkdown}

DELIVERABLE CONTRACT (binding):
${brief.deliverableSpec}

Write the full report to report.md in the worktree root. Return
{ laneId: "${L}", reportPath: "<absolute path to report.md>", summaryMarkdown, findings }
where findings is the JSON array from the contract with ids prefixed "${L}-" (e.g. "${L}-F1").`}
                    </Task>
                  </Worktree>
                );
              })}
            </Parallel>
          ) : null}

          {/* 3 · Guard: fusion needs at least two surviving lanes. Mounted only
                 once the lanes exist in the graph. */}
          {brief ? (
            <Task id="quorum" output={outputs.ufRoster} dependsOn={["lane-A", "lane-B", "lane-C", "lane-D"]}>
              {() => {
                if (laneRows.length < 2) {
                  throw new Error(
                    `ULTRAFUSION_INSUFFICIENT_LANES: only ${laneRows.length}/4 lanes produced output; nothing meaningful to fuse.`,
                  );
                }
                return {
                  mapping: JSON.stringify({
                    quorum: laneRows.map((r) => r.laneId),
                  }),
                };
              }}
            </Task>
          ) : null}

          {/* 4 · Blind fusion: anonymized content only. The roster is not
                 persisted yet; judge content, never authorship. */}
          {brief && ctx.outputMaybe(outputs.ufRoster, { nodeId: "quorum" }) ? (
            <Task id="fusion" output={outputs.ufFusion} agent={fusion} timeoutMs={10_800_000}>
              {`You are the fusion judge of a blind Ultrafusion round. ${laneRows.length} anonymous lanes
(${laneRows.map((r: any) => r.laneId).join(", ")}) independently executed the same brief. Lanes are
anonymized by letter; do NOT attempt to identify which model produced which lane — judge content only.

THE BRIEF THEY EXECUTED:
${brief?.briefMarkdown ?? ""}

PER-LANE MATERIAL (summaries below; read each lane's FULL report.md and any poc/ evidence at its path):
${laneRows
  .map(
    (r: any) => `--- lane ${r.laneId} (full report: ${r.reportPath}) ---
${r.summaryMarkdown}
findings: ${r.findings}`,
  )
  .join("\n\n")}

WRITE BOTH ARTIFACTS TO DISK with your file tools. Do NOT return their contents in your JSON
answer — they are far too large for a structured response, and an over-long answer fails the task.

1. Write ${c.dir}/fusion.md — the single best-of-all deliverable: merge the strongest material from
   every lane, resolve contradictions on the evidence (read the reports and any POC evidence at the
   paths above; re-verify surprising claims against the primary sources they cite), and organize it
   as the definitive answer to the brief.

2. Write ${c.dir}/adjudications.json — a JSON array covering EVERY finding id from every lane:
   [{ findingId, verdict, note }] where verdict is exactly one of
   "unique-accepted" | "shared-accepted" | "rejected-weak" | "rejected-wrong".
   - unique-accepted: made the fused result AND no other lane found it.
   - shared-accepted: made the fused result; one or more other lanes found substantially the same thing.
   - rejected-weak: not wrong, but not fused (vague, minor, unsupported, out of scope).
   - rejected-wrong: factually incorrect or misleading — say why in note.
   Be honest and specific; the note is the audit trail. Do not soften rejections. Every finding id
   that appears in the per-lane material above must appear exactly once in this file.

CALIBRATION — read this before you adjudicate. Accepting everything is a FAILURE of the judge, not a
compliment to the lanes. In a prior round a judge accepted 96 of 96 items, which made the scores
meaningless: they measured only who wrote more, not who was right. Hold a real bar:
   - "accepted" means the item CHANGED the fused deliverable. If you would ship the fused result
     unchanged without it, it is rejected-weak, however true it sounds.
   - Verify surprising, load-bearing, or quantitative claims against the primary source before
     accepting. An unverified claim that happens to be plausible is rejected-weak, not accepted.
     A claim you checked and found wrong is rejected-wrong; say what the source actually says.
   - Duplicates across lanes are shared-accepted for EVERY lane that found them — but near-misses
     that only gesture at the real issue are rejected-weak, not shared.
   - Restating the brief, the spec, or another lane's item without adding evidence or a concrete
     change is rejected-weak.
Report your own rejection rate in the headline. If it is under 10%, state explicitly why every lane
was that good — and if you cannot justify it, you have not judged hard enough; go back and re-apply
the bar.

Then return ONLY the two paths and a short headline verdict (a few sentences, under 1500 characters).`}
            </Task>
          ) : null}

          {/* 5 · Unblind: persist the roster only after fusion has decided. */}
          {fusionRow ? (
            <Task id="roster" output={outputs.ufRoster}>
              {() => ({
                mapping: JSON.stringify(
                  Object.fromEntries(
                    LETTERS.map((L, i) => [
                      L,
                      {
                        agentKey: LANES[perm[i]].key,
                        model: LANES[perm[i]].model,
                      },
                    ]),
                  ),
                ),
              })}
            </Task>
          ) : null}

          {/* 6 · Comparative scoring, derived from the blind adjudication. */}
          {fusionRow && roster
            ? LETTERS.map((L) => (
                <Task key={L} id={`score-${L}`} output={outputs.ufScore}>
                  {() => {
                    const map = parseJson(roster.mapping, {})[L] ?? {
                      agentKey: "unknown",
                      model: "unknown",
                    };
                    const laneRow = laneRows.find((r: any) => r.laneId === L);
                    const adj = (readAdjudications(fusionRow) as any[]).filter(
                      (a) => typeof a?.findingId === "string" && a.findingId.startsWith(`${L}-`),
                    );
                    const count = (v: string) => adj.filter((a) => a.verdict === v).length;
                    const u = count("unique-accepted");
                    const s = count("shared-accepted");
                    const w = count("rejected-weak");
                    const x = count("rejected-wrong");
                    const points = laneRow ? 3 * u + s - w - 3 * x : -10; // a dead lane scores below any live one
                    return {
                      laneId: L,
                      agentKey: map.agentKey,
                      model: map.model,
                      uniqueAccepted: u,
                      sharedAccepted: s,
                      rejectedWeak: w,
                      rejectedWrong: x,
                      points,
                      verdictNote: laneRow
                        ? `${adj.length} findings adjudicated: ${u} unique, ${s} shared, ${w} weak, ${x} wrong`
                        : "lane produced no output (failed or timed out)",
                    };
                  }}
                </Task>
              ))
            : null}

          {/* 7 · Artifact assembly — last node, so its row is the run output. */}
          {fusionRow && roster ? (
            <Task id="artifact" output={outputs.ufArtifact} dependsOn={["score-A", "score-B", "score-C", "score-D"]}>
              {() => {
                mkdirSync(c.dir, { recursive: true });
                if (!existsSync(fusionRow.fusedPath)) {
                  throw new Error(
                    `fusion.md missing at ${fusionRow.fusedPath} — the fusion agent must write it to disk.`,
                  );
                }
                const scores = LETTERS.map((L) => ctx.outputMaybe(outputs.ufScore, { nodeId: `score-${L}` })).filter(
                  Boolean,
                ) as any[];
                const ranked = [...scores].sort((a, b) => b.points - a.points);
                writeFileSync(
                  join(c.dir, "scores.json"),
                  JSON.stringify({ roster: parseJson(roster.mapping, {}), scores: ranked }, null, 2),
                );
                return {
                  dir: c.dir,
                  fusedPath: join(c.dir, "fusion.md"),
                  ranking: ranked
                    .map((r, i) => `${i + 1}. lane ${r.laneId} (${r.agentKey}) ${r.points}pts [${r.verdictNote}]`)
                    .join("\n"),
                };
              }}
            </Task>
          ) : null}
        </Sequence>
      </Aspects>
    </Workflow>
  );
});
