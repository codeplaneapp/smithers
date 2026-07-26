// smithers-source: authored
// smithers-display-name: Break Smithers (EDD Loop)
// smithers-description: Eval-driven-development loop — run haiku fluency evals, adversarially try to break smithers or produce a bad UX, author a new eval from what broke, fix the root cause, commit locally. Loops until a wall-clock deadline.
// smithers-tags: quality, evals, edd
/** @jsxImportSource smithers-orchestrator */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { createSmithers, UI } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";

/**
 * Break Smithers — a durable eval-driven-development loop.
 *
 * The philosophy (will@tevm.tech): we try to break smithers or catch a bad user
 * experience, turn that into an eval, and trust the eval loop to drive the fix.
 * We especially want evals proving the agent produces GREAT human-readable,
 * agent-written reports and UIs. Each iteration:
 *
 *   1. clock      — wall-clock gate; the loop stops after `deadlineIso`.
 *   2. run-haiku  — run one rotating haiku fluency suite (weak model stresses the
 *                   docs); capture pass/fail + the friction it surfaced.
 *   3. break      — Codex Luna adversarially drives smithers (author a workflow, run a
 *                   CLI verb, inspect a generated report/UI) to find ONE concrete
 *                   NEW friction or bad-experience failure.
 *   4. author     — Codex Luna turns that friction into a runnable eval case, appended
 *                   to the corpus + cases regenerated (the durable regression).
 *   5. fix        — Codex Luna fixes the root cause (docs preferred; minimal code if
 *                   needed) and returns exactly the files it touched.
 *   6. commit     — scoped LOCAL commit of the new eval + fix (git commit
 *                   <pathspec>, never add -A; no push/pull). Tolerant of races.
 *
 * Commit safety: this repo's working tree is shared with many concurrent agents.
 * We NEVER push/pull here (that's the documented index-corruption hazard) and
 * every git step is continueOnFail, so a race can never kill the loop — the
 * new evals stay on disk to be pushed later regardless.
 *
 * Run (detached, until 10pm today):
 *   smithers up .smithers/workflows/break-smithers.tsx -d \
 *     --input '{"deadlineIso":"2026-07-06T22:00:00-04:00"}'
 *   smithers ps ; smithers logs <run> --follow
 */

const researchAgent = agents.research;
const implementationAgent = agents.implement;

type SpawnResult = { status: number | null; stdout: string; stderr: string };

/**
 * Async, non-blocking replacement for `spawnSync`. A compute task that awaits
 * this returns a Promise, so the engine's event loop / heartbeat keeps ticking
 * while a multi-minute subprocess (the haiku eval suite) runs — instead of
 * `spawnSync` freezing the loop and making `smithers ps` show a false `stale`.
 * Mirrors the subset of the spawnSync result we consume (`status`, `stdout`,
 * `stderr`) plus the same `timeout`/`maxBuffer`/`cwd` semantics.
 */
function spawnAsync(
  cmd: string,
  args: string[],
  opts: { cwd: string; timeout?: number; maxBuffer?: number },
): Promise<SpawnResult> {
  const maxBuffer = opts.maxBuffer ?? 1024 * 1024;
  return new Promise<SpawnResult>((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(cmd),
    });
    let stdout = "";
    let stderr = "";
    let overflowed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const append = (buf: string, chunk: Buffer) => {
      if (overflowed) return buf;
      const next = buf + chunk.toString("utf8");
      if (next.length > maxBuffer) {
        overflowed = true;
        // Keep the tail (what callers slice), matching spawnSync's buffer cap intent.
        return next.slice(next.length - maxBuffer);
      }
      return next;
    };

    child.stdout?.on("data", (c: Buffer) => {
      stdout = append(stdout, c);
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr = append(stderr, c);
    });

    const finish = (status: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ status, stdout, stderr });
    };

    if (opts.timeout && opts.timeout > 0) {
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        // spawnSync reports status null when it kills on timeout.
        finish(null);
      }, opts.timeout);
    }

    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
  });
}

function workflowRoot(): string {
  return resolve(process.env.SMITHERS_BREAK_ROOT?.trim() || process.cwd());
}

function haikuSuites(root: string): string[] {
  const suitesDir = join(root, "evals", "suites");
  if (!existsSync(suitesDir)) return [];
  return readdirSync(suitesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => existsSync(join(suitesDir, name, "eval.tsx")) && existsSync(join(suitesDir, name, "cases.jsonl")))
    .filter((name) => {
      // Keep only suites that actually have a haiku case, so a rotation slot
      // never wastes an iteration on a suite haiku never runs.
      try {
        const lines = readFileSync(join(suitesDir, name, "cases.jsonl"), "utf8").split(/\r?\n/);
        return lines.some((l) => {
          try {
            return JSON.parse(l)?.input?.model === "haiku";
          } catch {
            return false;
          }
        });
      } catch {
        return false;
      }
    })
    .sort();
}

const inputSchema = z.object({
  deadlineIso: z
    .string()
    .datetime({ offset: true })
    .describe("Stop the loop once wall-clock time passes this ISO timestamp (e.g. 2026-07-06T22:00:00-04:00)."),
  maxIterations: z
    .number()
    .int()
    .min(1)
    .default(500)
    .describe("Hard cap on loop iterations (deadline usually stops it first)."),
  maxCasesPerSuite: z
    .number()
    .int()
    .min(1)
    .default(4)
    .describe("Cap haiku cases run per suite each iteration (keeps rounds bounded)."),
});

function containedRepoPaths(root: string, paths: string[]): string[] {
  const out: string[] = [];
  for (const raw of paths) {
    const candidate = raw.trim();
    if (!candidate || candidate.includes("\0") || isAbsolute(candidate)) continue;
    const normalized = normalize(candidate);
    const rel = relative(root, resolve(root, normalized));
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) continue;
    if (!out.includes(rel)) out.push(rel);
  }
  return out;
}

const clockSchema = z.object({
  round: z.number(),
  nowIso: z.string(),
  deadlineIso: z.string(),
  deadlinePassed: z.boolean(),
  suite: z.string(),
});

const evalRunSchema = z.object({
  suite: z.string(),
  exitCode: z.number(),
  ok: z.boolean(),
  reportPath: z.string().nullable(),
  tail: z.string().describe("Tail of the harness stdout/stderr — the pass/fail lines + surfaced friction."),
});

const frictionSchema = z.object({
  title: z.string().describe("One-line name of the friction / bad experience found."),
  area: z.string().describe("Feature-area bucket (cli, concepts, authoring, ui, reports, observability, ...)."),
  severity: z.enum(["low", "medium", "high"]),
  kind: z
    .enum(["docs", "code", "eval-only"])
    .describe("Is the root-cause fix a docs edit, a code change, or is this purely a new eval to add?"),
  repro: z.string().describe("Exact steps / command an agent can replay to hit this."),
  whatWasBad: z
    .string()
    .describe("Concretely what was wrong, missing, ambiguous, or a bad UX (e.g. an ugly/unreadable agent report)."),
  suggestedFix: z.string().describe("Source-grounded suggested fix (which doc/file, what to change)."),
});

const authoredSchema = z.object({
  id: z.string().describe("kebab-case eval id, prefixed 'break-'."),
  feature: z.string(),
  area: z.string(),
  kind: z.enum(["knowledge", "authoring"]),
  tier: z.enum(["weak", "sota"]).describe("weak unless it needs authoring a genuinely complex multi-feature workflow."),
  verify: z.enum(["equals", "contains", "graph", "judge"]),
  task: z.string().describe("The exact instruction handed to the candidate agent."),
  canonicalAnswer: z.string().nullable().default(null),
  mustNot: z.array(z.string()).default([]),
  notes: z.string().nullable().default(null).describe("For judge verify: the grading rubric."),
});

const wiredSchema = z.object({
  appended: z.boolean(),
  suite: z.string(),
  note: z.string(),
});

const fixedSchema = z.object({
  summary: z.string().describe("What was fixed and why it removes the friction."),
  files: z
    .array(z.string())
    .describe("Repo-relative paths this fix changed (used for the scoped commit). Empty if eval-only."),
  regeneratedDocs: z.boolean().describe("Whether `pnpm docs:llms` was run (required if any docs/*.mdx changed)."),
});

const committedSchema = z.object({
  committed: z.boolean(),
  message: z.string(),
  note: z.string(),
});

const { Workflow, Task, Sequence, Loop, smithers, outputs } = createSmithers({
  input: inputSchema,
  clock: clockSchema,
  evalRun: evalRunSchema,
  friction: frictionSchema,
  authored: authoredSchema,
  wired: wiredSchema,
  fixed: fixedSchema,
  committed: committedSchema,
});

const BREAK_PROMPT = (suite: string, tail: string) =>
  [
    "You are an adversarial QA agent for Smithers (the durable agent control plane in this repo).",
    "GOAL: find ONE concrete NEW way smithers is broken, confusing, or produces a BAD user experience.",
    "We especially care about: agent-written REPORTS and UIs that are ugly, unreadable, or unhelpful;",
    "CLI verbs/flags that mislead; docs that are wrong/ambiguous; crashes or confusing errors.",
    "",
    `A haiku fluency run of suite "${suite}" just finished. Its output tail (weak model stressing the docs):`,
    "```",
    tail.slice(-4000),
    "```",
    "",
    "ACTIVELY TRY TO BREAK IT. Do real things, don't theorize:",
    "  • Author a small workflow and `smithers graph`/`smithers up --dry-run` it; note any confusing failure.",
    "  • Run a plausible CLI verb an agent would guess; check the help/error is clear.",
    "  • Trigger a generated report/UI (e.g. a run report) and judge whether it reads well for a HUMAN.",
    "  • Consult skills/smithers/llms-full.txt + docs/llms-*.txt; find a claim that is wrong or missing.",
    "Pick the SINGLE highest-value finding and emit it as the structured friction report.",
    "Prefer findings that a NEW eval could regression-guard. Be specific and reproducible.",
  ].join("\n");

const AUTHOR_PROMPT = (friction: z.infer<typeof frictionSchema>) =>
  [
    "Turn this reported Smithers friction into ONE well-formed fluency-eval case.",
    "A fluency eval hands a (usually weak) model a Smithers task and checks it can one-shot it from the docs.",
    "",
    `FRICTION:\n${JSON.stringify(friction, null, 2)}`,
    "",
    "Ground the CORRECT answer in the docs/skill (skills/smithers/llms-full.txt, docs/llms-*.txt).",
    "Decide kind + verify + tier and write a precise `task` instruction. Verify mapping:",
    "  • equals/contains → a short knowledge answer; put the exact correct token in canonicalAnswer.",
    "  • graph → authoring; candidate writes a self-contained workflow that must render; put the required <Component tag in canonicalAnswer and any hallucinated API to forbid in mustNot.",
    "  • judge → open-ended (e.g. 'produce a readable report'); put the grading rubric in notes.",
    "Prefer weak tier. Use an id prefixed 'break-'. Emit the structured case only.",
  ].join("\n");

const FIX_PROMPT = (friction: z.infer<typeof frictionSchema>, authored: z.infer<typeof authoredSchema>) =>
  [
    "Fix the ROOT CAUSE of this Smithers friction so the next agent/user does not hit it.",
    `FRICTION:\n${JSON.stringify(friction, null, 2)}`,
    `A regression eval was just authored for it (id ${authored.id}).`,
    "",
    "Rules:",
    "  • Prefer a DOCS fix: edit the docs/*.mdx SOURCE, then run `pnpm docs:llms` to regenerate the bundles (CI gates on check-docs/check-llms).",
    "  • Only touch CODE when the robust fix is code, not docs; keep it minimal and matched to the surrounding style.",
    "  • This working tree is SHARED with other agents. Do NOT run `git add -A`, do NOT stage/commit/push, do NOT `git stash`, do NOT amend. Editing files is all you do; a later step commits your exact paths.",
    "  • If the friction is genuinely eval-only (no doc/code is wrong), change nothing and return an empty files list.",
    "Return a precise summary and the exact repo-relative paths you changed.",
  ].join("\n");

export default smithers((ctx) => {
  const root = workflowRoot();
  const curated = join(root, "evals/_inventory/curated-tasks.jsonl");
  const deadlineIso = ctx.input.deadlineIso;
  const maxIterations = ctx.input.maxIterations ?? 500;
  const maxCases = ctx.input.maxCasesPerSuite ?? 4;

  const SUITES = haikuSuites(root);
  // Iteration index = how many eval rounds have completed. Drives suite rotation.
  const doneRounds = (ctx.outputs.evalRun ?? []).length;
  const suite = SUITES.length ? SUITES[doneRounds % SUITES.length] : "authoring-workflows";

  // Deadline gate: read the most recent clock; stop once it reports the deadline passed.
  const clock = ctx.outputMaybe(outputs.clock, { nodeId: "clock" });
  const deadlinePassed = clock?.deadlinePassed === true;

  const evalRun = ctx.outputMaybe(outputs.evalRun, { nodeId: "run-haiku" });
  const friction = ctx.outputMaybe(outputs.friction, { nodeId: "break" });
  const authored = ctx.outputMaybe(outputs.authored, { nodeId: "author" });
  const fixed = ctx.outputMaybe(outputs.fixed, { nodeId: "fix" });

  return (
    <Workflow name="break-smithers">
      <UI entry="../ui/break-smithers.tsx" title={"Break Smithers · EDD loop"} />
      <Loop id="edd" until={deadlinePassed} maxIterations={maxIterations} onMaxReached="return-last">
        <Sequence>
          {/* 1. CLOCK — wall-clock deadline gate for the NEXT iteration. */}
          <Task id="clock" output={outputs.clock}>
            {() => {
              const now = new Date();
              const passed = now.getTime() >= Date.parse(deadlineIso);
              return {
                round: doneRounds,
                nowIso: now.toISOString(),
                deadlineIso,
                deadlinePassed: passed,
                suite,
              };
            }}
          </Task>

          {/* 2. RUN-HAIKU — one rotating haiku fluency suite; weak model stresses the docs. */}
          <Task id="run-haiku" output={outputs.evalRun} continueOnFail>
            {async () => {
              const res = await spawnAsync(
                process.env.SMITHERS_BREAK_BUN?.trim() || "bun",
                [
                  join(root, "evals/harness/run-suite.ts"),
                  suite,
                  "--only-model",
                  "haiku",
                  "--max-cases",
                  String(maxCases),
                  "-j",
                  "4",
                ],
                { cwd: root, timeout: 20 * 60_000, maxBuffer: 64 * 1024 * 1024 },
              );
              const out = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
              const reportPath = join(root, "evals/harness/.report", `${suite}.json`);
              return {
                suite,
                exitCode: res.status ?? -1,
                ok: (res.status ?? -1) === 0,
                reportPath: existsSync(reportPath) ? reportPath : null,
                tail: out.slice(-6000),
              };
            }}
          </Task>

          {/* 3. BREAK — Luna adversarially finds ONE new friction / bad UX. */}
          <Task id="break" output={outputs.friction} agent={researchAgent} heartbeatTimeoutMs={900_000}>
            {BREAK_PROMPT(suite, evalRun?.tail ?? "(no eval output captured)")}
          </Task>

          {/* 4. AUTHOR — Luna turns the friction into a runnable eval case. */}
          {friction ? (
            <Task id="author" output={outputs.authored} agent={implementationAgent} heartbeatTimeoutMs={600_000}>
              {AUTHOR_PROMPT(friction)}
            </Task>
          ) : null}

          {/* 4b. WIRE — append the case to the corpus + regenerate cases (deterministic). */}
          {authored ? (
            <Task id="wire" output={outputs.wired} continueOnFail>
              {async () => {
                const task = {
                  id: authored.id,
                  feature: authored.feature,
                  area: authored.area,
                  kind: authored.kind,
                  tier: authored.tier,
                  verify:
                    authored.verify === "graph" || authored.verify === "judge" ? authored.verify : "deterministic",
                  task: authored.task,
                  canonicalAnswer: authored.canonicalAnswer ?? "",
                  mustNot: authored.mustNot ?? [],
                  notes: authored.notes ?? "",
                  source: "break-smithers",
                };
                let already = false;
                if (existsSync(curated)) {
                  already = readFileSync(curated, "utf8")
                    .split(/\r?\n/)
                    .some((l) => {
                      try {
                        return JSON.parse(l)?.id === task.id;
                      } catch {
                        return false;
                      }
                    });
                }
                if (!already) {
                  const { appendFileSync } = require("node:fs");
                  appendFileSync(curated, `${JSON.stringify(task)}\n`);
                }
                const gen = await spawnAsync(
                  process.env.SMITHERS_BREAK_BUN?.trim() || "bun",
                  [join(root, "evals/harness/generate-cases.ts")],
                  { cwd: root, timeout: 5 * 60_000 },
                );
                return {
                  appended: !already,
                  suite: friction?.area ?? "real-usage",
                  note: already
                    ? `Case ${task.id} already existed; regenerated cases (gen exit ${gen.status}).`
                    : `Appended ${task.id} to corpus and regenerated cases (gen exit ${gen.status}).`,
                };
              }}
            </Task>
          ) : null}

          {/* 5. FIX — Luna fixes the root cause (docs preferred), returns changed paths. */}
          {authored ? (
            <Task id="fix" output={outputs.fixed} agent={implementationAgent} heartbeatTimeoutMs={1_200_000}>
              {FIX_PROMPT(friction!, authored)}
            </Task>
          ) : null}

          {/* 6. COMMIT — scoped LOCAL commit (git commit <pathspec>, no add -A, no push/pull). */}
          {fixed ? (
            <Task id="commit" output={outputs.committed} continueOnFail>
              {async () => {
                const paths = containedRepoPaths(root, [
                  "evals/_inventory/curated-tasks.jsonl",
                  "evals/suites",
                  ...(fixed.files ?? []),
                ]).filter((p) => existsSync(join(root, p)));
                if (paths.length === 0) {
                  return { committed: false, message: "", note: "Nothing to commit." };
                }
                const title = (friction?.title ?? "friction").replace(/["`]/g, "").slice(0, 60);
                const message = `✅ test(evals): break-smithers loop — ${title}\n\nEDD loop: new adversarial eval + root-cause fix for a friction surfaced against smithers.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`;
                // Pathspec commit: stages+commits ONLY these paths, leaving other
                // agents' unstaged work untouched. No push/pull on the shared tree.
                const res = await spawnAsync("git", ["commit", "-m", message, "--", ...paths], {
                  cwd: root,
                  timeout: 3 * 60_000,
                });
                const combined = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
                const committed = (res.status ?? -1) === 0;
                return {
                  committed,
                  message: committed ? title : "",
                  note: committed
                    ? `Committed ${paths.length} path(s) locally.`
                    : `No commit (exit ${res.status}): ${combined.slice(-300).trim()}`,
                };
              }}
            </Task>
          ) : null}
        </Sequence>
      </Loop>
    </Workflow>
  );
});
