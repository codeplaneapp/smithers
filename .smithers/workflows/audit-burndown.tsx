// smithers-source: authored
// smithers-display-name: Audit Burndown
/** @jsxImportSource smthrs */
import { createSmithers, Sequence, Parallel, Loop, Worktree } from "smthrs";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, relative } from "node:path";
import { z } from "zod/v4";
import { agents } from "../agents";
import { ValidationLoop, implementOutputSchema, validateOutputSchema } from "../components/ValidationLoop";
import { reviewOutputSchema } from "../components/Review";

/**
 * Audit Burndown — a long-running (multi-week), validation-first burndown engine
 * for the bulletproof-audit backlog in `.smithers/tickets/smithers/*.md`.
 *
 * Design goals (the whole point of this workflow):
 *  1. SMALL TASKS. The unit of work is a single open `- [ ]` checkbox item, not a
 *     whole ticket. An agent does ONE small item per worktree, so progress is
 *     incremental and reviewable.
 *  2. PROVE THE WORK IS WORKING. Per-item agents implement + self-validate +
 *     get independently reviewed inside an isolated `<Worktree>`. But the
 *     AUTHORITATIVE proof is the COMPLETENESS ORACLE: a deterministic compute
 *     task that, after the batch merges to local main, runs the REAL full gate
 *     (`pnpm typecheck` + `pnpm test`) on the real main checkout — where every
 *     workspace package resolves correctly — and records the result. Agents
 *     cannot fake a compute task's exit code, and only a green full-gate-on-main
 *     proves the landed changes actually work end-to-end.
 *  3. OBSERVABILITY PROVING COMPLETENESS. Every outer iteration writes a
 *     `completeness` row: open-item count before/after, items closed this batch,
 *     and the main-gate result. That table is queryable (`smithers inspect`,
 *     `smithers node oracle -r <run>`, `smithers events`) and traced via OTLP,
 *     so the burndown is observable and "done" is provable: openCount == 0 AND
 *     the full gate is green on main.
 *  4. MULTI-WEEK / DURABLE. The whole thing is wrapped in an outer `<Loop>` that
 *     re-discovers a fresh batch each iteration and stops only when the backlog
 *     is empty and main is green. Run it with `smithers up … --detach` +
 *     `smithers supervise` and it survives restarts via resume, grinding the
 *     backlog down over days/weeks one verified batch at a time.
 *  5. NEVER PUSHES — PUSH-SAFE. The workflow ONLY ever merges to LOCAL `main`; a
 *     human pushes out-of-band after review. Every agent prompt carries an
 *     absolute push ban + a stay-scoped rule (an early run had an agent wander
 *     off its item and push a debugging trail to shared origin — that must never
 *     happen again). A deterministic PUSH FENCE captures origin/main at start and
 *     the oracle re-checks every iteration for any `burndown/*` branch on origin
 *     or any origin/main drift; on detection it halts at the `oracle-fix`
 *     approval. For hard prevention, run the agents with a token that has no push
 *     scope (or in a sandbox without origin write creds) — prompts alone are not
 *     a security boundary.
 *
 * Run (the workflow never pushes; you push after reviewing local main):
 *   smithers up .smithers/workflows/audit-burndown.tsx --detach \
 *     --input '{"batchSize":4,"maxConcurrency":2,"runFullGate":true,"ticketPrefixes":["0052"]}'
 *   smithers supervise            # auto-resume on owner-process death
 *   smithers ps                   # watch it
 *   smithers node oracle -r RUN   # the completeness proof + push-fence status per iteration
 *   smithers logs RUN --follow    # live progress
 */

const batchItemSchema = z.object({
  slug: z.string(),
  ticketFile: z.string(),
  lineNo: z.number().int(),
  itemText: z.string(),
  pkg: z.string().nullable().default(null),
});

const batchSchema = z.object({
  items: z.array(batchItemSchema).default([]),
  openCount: z.number().int().default(0),
  summary: z.string().default(""),
});

const itemResultSchema = z.object({
  slug: z.string(),
  ticketFile: z.string(),
  itemText: z.string(),
  branch: z.string(),
  status: z.enum(["success", "partial", "failed"]).default("partial"),
  summary: z.string().default(""),
});

const mergeSchema = z.object({
  merged: z.array(z.string()).default([]),
  skipped: z.array(z.string()).default([]),
  summary: z.string().default(""),
});

const completenessSchema = z.object({
  openCountBefore: z.number().int().default(0),
  openCountAfter: z.number().int().default(0),
  closedThisBatch: z.number().int().default(0),
  mainTypecheckGreen: z.boolean().default(false),
  mainTestGreen: z.boolean().default(false),
  mainGateGreen: z.boolean().default(false),
  ranFullGate: z.boolean().default(false),
  /** Push fence: true if an agent pushed to origin (rogue burndown branch or origin/main drift). */
  roguePushDetected: z.boolean().default(false),
  roguePushDetail: z.string().default(""),
  summary: z.string().default(""),
  output: z.string().default(""),
});

/** Captured once at workflow start: the origin/main SHA the run must never move. */
const baselineSchema = z.object({
  originMainSha: z.string().default(""),
  capturedAt: z.string().default(""),
});

const approvalSchema = z.object({
  approved: z.boolean(),
  note: z.string().nullable(),
  decidedBy: z.string().nullable(),
  decidedAt: z.string().nullable(),
});

const inputSchema = z.object({
  /** How many small items to work per outer iteration. */
  batchSize: z.number().int().min(1).default(4),
  /** How many worktrees run in parallel within a batch. */
  maxConcurrency: z.number().int().min(1).default(2),
  /** Cap on outer iterations (high — this is meant to run for weeks). */
  maxOuterIterations: z.number().int().min(1).default(200),
  /** Per-item implement→validate→review loop cap. */
  maxItemIterations: z.number().int().min(1).default(3),
  /** Run the heavy full `pnpm typecheck && pnpm test` in the oracle (authoritative). */
  runFullGate: z.boolean().default(true),
  /** Glob-ish ticket-id prefixes to target (e.g. ["0052","0047"]); empty = all. */
  ticketPrefixes: z.array(z.string()).default([]),
});

const { Workflow, Task, Approval, smithers, outputs } = createSmithers({
  input: inputSchema,
  baseline: baselineSchema,
  batch: batchSchema,
  itemResult: itemResultSchema,
  merge: mergeSchema,
  completeness: completenessSchema,
  approval: approvalSchema,
  implement: implementOutputSchema,
  validate: validateOutputSchema,
  review: reviewOutputSchema,
});

type BatchItem = z.infer<typeof batchItemSchema>;

const TICKETS_DIR = ".smithers/tickets/smithers";

/** Sub-bullet markers that mean an item is already resolved/deferred/dispositioned. */
const RESOLVED_MARKERS = ["_done", "_disposition", "_correction", "_resolved", "_scope assessment", "_partial"];

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/** Heuristically pull a `packages/<x>` or `apps/<x>` package dir out of item text. */
function guessPackage(text: string): string | null {
  const m = text.match(/\b(packages|apps)\/([a-z0-9-]+)/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * Scan the audit tickets for genuinely-actionable open `- [ ]` checkbox items:
 * an open checkbox whose immediately-following sub-bullet is NOT a disposition/
 * done/deferred note. Returns them oldest-ticket-first, with a stable slug.
 */
function discoverActionableItems(prefixes: string[]): BatchItem[] {
  const root = resolve(process.cwd(), TICKETS_DIR);
  let files: string[];
  try {
    files = readdirSync(root).filter((f) => f.endsWith(".md") && f.toLowerCase() !== "readme.md");
  } catch {
    return [];
  }
  files.sort();
  const out: BatchItem[] = [];
  for (const file of files) {
    const ticketId = file.slice(0, 4);
    if (prefixes.length > 0 && !prefixes.some((p) => file.startsWith(p))) continue;
    const rel = `${TICKETS_DIR}/${file}`;
    let lines: string[];
    try {
      lines = readFileSync(resolve(process.cwd(), rel), "utf8").split("\n");
    } catch {
      continue;
    }
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (!/^\s*- \[ \]/.test(line)) continue;
      // Look at the next non-empty line: if it's a disposition/done sub-bullet, skip.
      let j = i + 1;
      while (j < lines.length && (lines[j] ?? "").trim() === "") j++;
      const next = (lines[j] ?? "").trim();
      const isResolved = RESOLVED_MARKERS.some((m) => next.startsWith(`- ${m}`) || next.startsWith(m));
      if (isResolved) continue;
      const itemText = line.replace(/^\s*- \[ \]\s*/, "").trim();
      out.push({
        slug: `${ticketId}-${slugify(itemText)}-${i}`,
        ticketFile: rel,
        lineNo: i + 1,
        itemText,
        pkg: guessPackage(itemText),
      });
    }
  }
  return out;
}

function itemPrompt(item: BatchItem): string {
  return [
    `You are completing ONE small audit item end-to-end on this branch. Keep the change tightly scoped to exactly this item — do not bundle unrelated work.`,
    ``,
    `TICKET FILE: ${item.ticketFile} (line ${item.lineNo})`,
    `ITEM: ${item.itemText}`,
    item.pkg ? `LIKELY PACKAGE: ${item.pkg}` : ``,
    ``,
    `Requirements:`,
    `- Make the smallest correct change that fully satisfies the item.`,
    `- Follow CLAUDE.md: atomic emoji+conventional commits, NO mocks in product/e2e, keep the committed src/index.d.ts in sync by hand when you change a public export (tsup does not regen it here).`,
    `- VERIFY locally before you finish: run the affected package's \`pnpm -C <pkg> typecheck\` and \`test\`, plus root \`pnpm lint\` and \`node scripts/check-dependency-boundaries.mjs\`. If you touched docs/, run \`node scripts/check-docs.mjs\` and \`node scripts/check-llms.mjs\` (regenerate bundles with \`pnpm docs:llms\`).`,
    `- If the item turns out to be already-done, stale, by-design, or genuinely multi-week, do NOT fake it: instead edit the ticket to replace the \`- [ ]\` with \`- [x]\` (if truly done) or add a \`  - _disposition (date):_ …\` sub-bullet explaining why, and commit that. An honest disposition counts as completing the item.`,
    `- STAY STRICTLY SCOPED to THIS item. If you discover an unrelated failing test, flaky CI, or a bug in another area, do NOT chase or fix it — write one sentence about it in your result summary and finish THIS item. Do not bundle, refactor, or go on tangents.`,
    `- When the code change is done, CHECK THE BOX: change the item's \`- [ ]\` to \`- [x]\` in ${item.ticketFile} and add a one-line \`— done: …\` note, then commit.`,
    ``,
    `🚫 ABSOLUTE PUSH BAN — read carefully:`,
    `- NEVER run \`git push\`, \`git push --force\`, \`gh pr create\`, or anything that writes to the remote/origin. Not now, not "to be safe", not at the end. The orchestrating workflow owns all interaction with origin; an agent push corrupts shared \`main\`.`,
    `- Do NOT run \`git remote\` mutations, do NOT change branches off your worktree branch, do NOT touch \`main\` directly. Work ONLY on this worktree's branch.`,
    `- Commit your work to THIS worktree branch with local commits only. That is the entire extent of your git interaction. If you think you need to push, you are wrong — stop and finish without pushing.`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Per-item done = validation passed AND a reviewer approved (mirrors ValidationLoop semantics). */
function itemDone(ctx: any, idPrefix: string): { done: boolean; feedback: string | null } {
  const validate =
    ctx.latest("validate", `${idPrefix}:validate`) ??
    ctx.outputMaybe(outputs.validate, { nodeId: `${idPrefix}:validate` });
  const reviews = (ctx.outputs.review ?? []) as Array<z.infer<typeof reviewOutputSchema> & { nodeId?: string }>;
  const validationIteration = (validate as { iteration?: number } | undefined)?.iteration;
  const mine = reviews.filter(
    (r) =>
      typeof r.nodeId === "string" &&
      r.nodeId.startsWith(`${idPrefix}:review:`) &&
      (r as { iteration?: number }).iteration === validationIteration,
  );
  const validationPassed = validate?.allPassed === true;
  const anyApproved = mine.length > 0 && mine.some((r) => r.approved === true);
  const done = validationPassed && anyApproved;
  if (validate === undefined) return { done: false, feedback: null };
  const parts: string[] = [];
  if (!validationPassed && validate.failingSummary) parts.push(`VALIDATION FAILED:\n${validate.failingSummary}`);
  for (const r of mine) {
    if (r.approved === false) {
      parts.push(`REVIEWER REJECTED:\n${r.feedback}`);
      for (const issue of r.issues ?? [])
        parts.push(`  [${issue.severity}] ${issue.title}: ${issue.description}${issue.file ? ` (${issue.file})` : ""}`);
    }
  }
  return { done, feedback: parts.length ? parts.join("\n\n") : null };
}

export default smithers((ctx) => {
  const batchSize = ctx.input.batchSize ?? 4;
  const maxConcurrency = ctx.input.maxConcurrency ?? 2;
  const maxOuterIterations = ctx.input.maxOuterIterations ?? 200;
  const maxItemIterations = ctx.input.maxItemIterations ?? 3;
  const runFullGate = ctx.input.runFullGate ?? true;
  const ticketPrefixes = ctx.input.ticketPrefixes ?? [];

  // Current batch (this outer iteration). Re-discovered fresh each iteration so
  // closed items drop out and new ones rotate in.
  const batch = ctx.outputMaybe(outputs.batch, { nodeId: "discover" });
  const items = (batch?.items ?? []) as BatchItem[];
  const ticketResults = (ctx.outputs.itemResult ?? []) as Array<z.infer<typeof itemResultSchema>>;

  // Push fence baseline: the origin/main SHA captured once at run start. The
  // workflow itself NEVER pushes, so if origin moves, an agent (or a human)
  // pushed — the oracle flags it and the run halts.
  const baseline = ctx.outputMaybe(outputs.baseline, { nodeId: "baseline" });
  const baselineSha = baseline?.originMainSha ?? "";

  // Outer-loop termination: the latest oracle proves an empty, green backlog.
  const oracle = ctx.outputMaybe(outputs.completeness, { nodeId: "oracle" });
  const backlogEmpty = oracle?.openCountAfter === 0;
  const mainGreen = oracle?.mainGateGreen === true;
  const roguePush = oracle?.roguePushDetected === true;
  // Done only when backlog empty, main green, AND no rogue push ever detected.
  const burndownDone = backlogEmpty && mainGreen && !roguePush;
  const oracleHalt =
    oracle !== undefined &&
    ((oracle.ranFullGate && oracle.mainGateGreen === false) || oracle.roguePushDetected === true);

  return (
    <Workflow name="audit-burndown">
      <Sequence>
        {/* 0. PUSH-FENCE BASELINE — capture origin/main once; the run must never move it. */}
        <Task id="baseline" output={outputs.baseline}>
          {async () => {
            const { spawnSync } = await import("node:child_process");
            const git = process.platform === "win32" ? "git.exe" : "git";
            spawnSync(git, ["fetch", "-q", "origin", "main"], {
              cwd: resolve(process.cwd()),
              encoding: "utf8",
              timeout: 120_000,
            });
            const res = spawnSync(git, ["rev-parse", "origin/main"], {
              cwd: resolve(process.cwd()),
              encoding: "utf8",
              timeout: 60_000,
            });
            return { originMainSha: (res.stdout ?? "").trim(), capturedAt: new Date().toISOString() };
          }}
        </Task>
        <Loop id="burndown" until={burndownDone} maxIterations={maxOuterIterations} onMaxReached="return-last">
          <Sequence>
            {/* 1. DISCOVER — deterministic scan for small actionable items, pick a batch. */}
            <Task id="discover" output={outputs.batch}>
              {() => {
                const all = discoverActionableItems(ticketPrefixes);
                const chosen = all.slice(0, batchSize);
                return {
                  items: chosen,
                  openCount: all.length,
                  summary: `${all.length} actionable open items; working ${chosen.length}: ${chosen.map((c) => c.slug).join(", ") || "(none)"}`,
                };
              }}
            </Task>

            {/* 2. WORK — one small item per isolated worktree, in parallel. */}
            <Parallel maxConcurrency={maxConcurrency}>
              {items.map((item) => {
                const idPrefix = `bd-${item.slug}`;
                const { done, feedback } = itemDone(ctx, idPrefix);
                const validation =
                  ctx.latest("validate", `${idPrefix}:validate`) ??
                  ctx.outputMaybe(outputs.validate, { nodeId: `${idPrefix}:validate` });
                return (
                  <Worktree
                    key={item.slug}
                    path={resolve(process.cwd(), `.worktrees/burndown-${item.slug}`)}
                    branch={`burndown/${item.slug}`}
                  >
                    <Sequence>
                      <ValidationLoop
                        idPrefix={idPrefix}
                        prompt={itemPrompt(item)}
                        implementAgents={agents.implement}
                        validateAgents={agents.midTier}
                        reviewAgents={[agents.review]}
                        feedback={feedback}
                        done={done}
                        reviewWhen={validation?.allPassed === true}
                        maxIterations={maxItemIterations}
                      />
                      <Task id={`result-${item.slug}`} output={outputs.itemResult} continueOnFail>
                        {{
                          slug: item.slug,
                          ticketFile: item.ticketFile,
                          itemText: item.itemText,
                          branch: `burndown/${item.slug}`,
                          status: done ? "success" : "partial",
                          summary: done ? `Completed: ${item.itemText}` : `Did not converge: ${item.itemText}`,
                        }}
                      </Task>
                    </Sequence>
                  </Worktree>
                );
              })}
            </Parallel>

            {/* 3. MERGE — land only the green+approved branches onto LOCAL main. NEVER push. */}
            <Task id="merge" output={outputs.merge} agent={agents.implement}>
              {[
                `Merge the completed burndown branches from this batch into LOCAL \`main\` only.`,
                ``,
                `🚫 ABSOLUTE PUSH BAN: NEVER run \`git push\`, \`git push --force\`, or anything that writes to origin/remote. Pushing to shared \`main\` is forbidden and corrupts everyone's tree. A human pushes out-of-band after reviewing; your job ends at the local merge.`,
                ``,
                `Batch results:`,
                ticketResults
                  .filter((r) => items.some((item) => item.slug === r.slug))
                  .map((r) => `- ${r.slug} [${r.status}] branch "${r.branch}" — ${r.summary}`)
                  .join("\n") || "(none)",
                ``,
                `Rules:`,
                `- Only merge branches whose status is "success". Skip "partial"/"failed" and list them in \`skipped\`.`,
                `- Merge each onto LOCAL main with a fast-forward or a clean merge commit; resolve trivial ticket-file conflicts by unioning the checkbox/disposition edits.`,
                `- After merging, run \`pnpm typecheck\` and \`pnpm lint\` at the repo root and fix any trivial merge fallout before finishing. STAY SCOPED — do not chase unrelated failures.`,
                `- Report \`merged\` (slugs landed on local main), \`skipped\` (slugs left behind + why), and a short \`summary\`. Do NOT push.`,
              ].join("\n")}
            </Task>

            {/* 4. COMPLETENESS ORACLE — the authoritative proof. Re-count open items and
              run the REAL full gate on the real main checkout. This is what makes
              "done" provable and observable; agents cannot fake the exit codes. */}
            <Task id="oracle" output={outputs.completeness}>
              {async () => {
                const { spawnSync } = await import("node:child_process");
                const openBefore = batch?.openCount ?? 0;
                const remaining = discoverActionableItems(ticketPrefixes);
                const openAfter = remaining.length;
                const git = process.platform === "win32" ? "git.exe" : "git";
                const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
                const run = (command: string, args: string[]) => {
                  const res = spawnSync(command, args, {
                    cwd: process.cwd(),
                    encoding: "utf8",
                    timeout: 1_800_000,
                    maxBuffer: 64 * 1024 * 1024,
                    env: process.env,
                  });
                  const combined = `${res.stdout ?? ""}\n${res.stderr ?? ""}`.trim();
                  return { code: typeof res.status === "number" ? res.status : null, out: combined };
                };
                // ── PUSH FENCE ── the workflow never pushes, so any origin movement
                // or any burndown/* branch on origin means an agent pushed. Detect + halt.
                run(git, ["fetch", "-q", "origin", "main"]);
                const remoteBurndown = run(git, ["ls-remote", "--heads", "origin", "burndown/*"]).out.trim();
                const currentOriginSha = run(git, ["rev-parse", "origin/main"]).out.trim();
                const originMoved =
                  baselineSha.length > 0 && currentOriginSha.length > 0 && currentOriginSha !== baselineSha;
                const roguePushDetected = remoteBurndown.length > 0 || originMoved;
                const roguePushDetail = roguePushDetected
                  ? [
                      remoteBurndown.length > 0 ? `burndown/* branch(es) pushed to origin:\n${remoteBurndown}` : "",
                      originMoved
                        ? `origin/main moved off baseline ${baselineSha.slice(0, 10)} → ${currentOriginSha.slice(0, 10)} (the workflow never pushes — an agent or a human did)`
                        : "",
                    ]
                      .filter(Boolean)
                      .join("\n")
                  : "";
                let typecheckGreen = true;
                let testGreen = true;
                let tail = "";
                if (runFullGate) {
                  const tc = run(pnpm, ["typecheck"]);
                  typecheckGreen = tc.code === 0;
                  tail += `\n=== pnpm typecheck (exit ${tc.code}) ===\n${tc.out.slice(-4000)}`;
                  if (typecheckGreen) {
                    const t = run(pnpm, ["test"]);
                    testGreen = t.code === 0;
                    tail += `\n=== pnpm test (exit ${t.code}) ===\n${t.out.slice(-6000)}`;
                  } else {
                    testGreen = false;
                    tail += `\n=== pnpm test SKIPPED (typecheck red) ===`;
                  }
                }
                const mainGateGreen = runFullGate ? typecheckGreen && testGreen : true;
                return {
                  openCountBefore: openBefore,
                  openCountAfter: openAfter,
                  closedThisBatch: Math.max(0, openBefore - openAfter),
                  mainTypecheckGreen: typecheckGreen,
                  mainTestGreen: testGreen,
                  mainGateGreen,
                  ranFullGate: runFullGate,
                  roguePushDetected,
                  roguePushDetail,
                  summary: `open ${openBefore}→${openAfter} (closed ${Math.max(0, openBefore - openAfter)}); main gate ${mainGateGreen ? "GREEN" : "RED"}${runFullGate ? "" : " (full gate skipped)"}${roguePushDetected ? "; ⚠️ ROGUE PUSH DETECTED" : ""}`,
                  output: (roguePushDetail ? `=== PUSH FENCE ===\n${roguePushDetail}\n` : "") + tail.slice(-12000),
                };
              }}
            </Task>

            {/* 5. SAFETY — halt for a human if the batch turned main RED *or* the push
              fence detected a rogue push. Never grind on a broken base; never let an
              agent push to shared origin go unnoticed. */}
            {oracleHalt ? (
              <Approval
                id="oracle-fix"
                output={outputs.approval}
                request={{
                  title: roguePush
                    ? `Audit burndown PUSH FENCE tripped — an agent pushed to origin`
                    : `Audit burndown turned main RED after the last batch`,
                  summary: [
                    roguePush
                      ? `🚨 The push fence detected a write to origin. The workflow never pushes, so an agent (or a human) moved the remote. Investigate and reconcile origin before continuing.`
                      : `The completeness oracle ran the full gate on main and it FAILED.`,
                    oracle?.summary ?? "",
                    ``,
                    `APPROVE once you have reconciled origin / fixed main back to green to continue the burndown,`,
                    `or DENY to stop the run for manual takeover.`,
                    ``,
                    `--- oracle / fence output (tail) ---`,
                    (oracle?.output ?? "").slice(-4000),
                  ].join("\n"),
                  metadata: { openCountAfter: oracle?.openCountAfter ?? null, roguePush },
                }}
                onDeny="fail"
              />
            ) : null}
          </Sequence>
        </Loop>
      </Sequence>
    </Workflow>
  );
});
