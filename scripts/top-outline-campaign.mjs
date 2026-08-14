#!/usr/bin/env bun
/**
 * Sequential fixture-based outline campaign for `smithers top` vibe-check.
 *
 * Runs structural twins of common workflows (token-free scripted agents) into
 * a shared smithers.db so a long-lived overview can fleet-watch each shape.
 *
 * Order (default):
 *   1. smithering     — long multi-phase + research/probe/review fan-outs
 *   2. mission        — plan → approve → execute → final
 *   3. issues         — discover → group → plan/implement/review fan-out → PR
 *   4. implement      — implement → validate → polish
 *   5. code-review    — prepare → parallel reviewers → summary
 *   6. hello          — single agent (baseline)
 *
 * Usage (overview already open):
 *   bun apps/cli/src/index.js top --db /path/to/smithers.db
 *   SMITHERS_CAMPAIGN_DB=/path/to/smithers.db bun ./scripts/top-outline-campaign.mjs
 *
 * Options via env:
 *   SMITHERS_OUTLINE_PACING=fast|normal|slow   (default normal)
 *   SMITHERS_OUTLINE_ONLY=smithering,mission   (comma ids)
 *   SMITHERS_OUTLINE_PAUSE_MS=2500             (between scenarios)
 */
import { createElement } from "react";
import { z } from "zod";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { Workflow, Task, Sequence, Parallel, Loop, runWorkflow, createSmithers } from "smthrs";
import { createVirtualClock } from "../packages/testing/src/index.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const dbPath =
  typeof process.env.SMITHERS_CAMPAIGN_DB === "string" && process.env.SMITHERS_CAMPAIGN_DB !== ""
    ? process.env.SMITHERS_CAMPAIGN_DB
    : join(ROOT, "smithers.db");

const pacingMode = String(process.env.SMITHERS_OUTLINE_PACING ?? "normal").toLowerCase();
const BASE_PACING =
  pacingMode === "fast"
    ? { minMs: 500, maxMs: 900 }
    : pacingMode === "slow"
      ? { minMs: 3_500, maxMs: 5_500 }
      : { minMs: 1_400, maxMs: 2_600 };

const pauseMs = Number(process.env.SMITHERS_OUTLINE_PAUSE_MS ?? 2_000);
const onlyRaw = process.env.SMITHERS_OUTLINE_ONLY;
const only = onlyRaw
  ? new Set(
      String(onlyRaw)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    )
  : null;

const out = z.object({ summary: z.string(), ok: z.boolean().default(true) });
const clock = createVirtualClock({ mode: "real" });

function scalePacing(mult) {
  return {
    minMs: Math.round(BASE_PACING.minMs * mult),
    maxMs: Math.round(BASE_PACING.maxMs * mult),
  };
}

function pacedAgent({ id, model, family, output, text, pacing }) {
  return {
    id,
    model,
    cliEngine: family,
    tools: {},
    supportsNativeStructuredOutput: true,
    async generate(args = {}) {
      const min = pacing.minMs;
      const max = Math.max(min, pacing.maxMs);
      const delay = min + Math.floor(Math.random() * (max - min + 1));
      await clock.sleep(delay);
      const line = text ?? `[scripted:${family}] ${id}\n`;
      if (typeof args.onStdout === "function") args.onStdout(line);
      return { output: output ?? { summary: id, ok: true }, text: line };
    },
  };
}

const fable = (id, text, pacing, output) =>
  pacedAgent({
    id,
    model: "claude-fable-5",
    family: "claude-code",
    text,
    pacing,
    output,
  });
const sonnet = (id, text, pacing, output) =>
  pacedAgent({
    id,
    model: "claude-sonnet-5",
    family: "claude-code",
    text,
    pacing,
    output,
  });
const codex = (id, text, pacing, output) =>
  pacedAgent({
    id,
    model: "gpt-5.5",
    family: "codex",
    text,
    pacing,
    output,
  });
const gemini = (id, text, pacing, output) =>
  pacedAgent({
    id,
    model: "gemini-3-flash",
    family: "gemini",
    text,
    pacing,
    output,
  });

function agentTask(id, label, output, agent) {
  return createElement(Task, { id, label, output, agent, retries: 0 }, label);
}
function detTask(id, label, output, value) {
  return createElement(Task, { id, label, output, retries: 0 }, value);
}

async function runOne(scenario) {
  const pacing = scalePacing(scenario.pace ?? 1);
  const schemas = scenario.schemas;
  const api = createSmithers(schemas, { backend: "sqlite", dbPath });
  const { smithers, outputs, db } = api;
  const runId = `${scenario.id}-${Date.now().toString(36)}`;
  const t0 = Date.now();
  console.log(`\n[outline-campaign] → ${scenario.id}: ${scenario.title}`);
  console.log(`[outline-campaign]    runId=${runId}  pace×${scenario.pace ?? 1} (${pacing.minMs}-${pacing.maxMs}ms)`);

  const wf =
    typeof scenario.buildWithCtx === "function"
      ? scenario.buildWithCtx(api, pacing)
      : smithers(() => scenario.build({ outputs, pacing, fable, sonnet, codex, gemini, runId }));

  try {
    const result = await Effect.runPromise(
      runWorkflow(wf, {
        runId,
        rootDir: ROOT,
        clock,
        input: scenario.input ?? {},
      }),
    );
    if (!result || result.status !== "finished" || result.degraded === true) {
      throw new Error(`run ended with status=${String(result?.status)} degraded=${String(result?.degraded)}`);
    }
    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[outline-campaign] ✓ ${scenario.id} finished in ${sec}s`);
    return { id: scenario.id, runId, ok: true, sec };
  } catch (e) {
    console.error(`[outline-campaign] ✗ ${scenario.id}`, e instanceof Error ? e.message : e);
    return { id: scenario.id, runId, ok: false, error: String(e) };
  } finally {
    try {
      db?.$client?.close?.();
    } catch {
      /* ignore */
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** @type {Array<{ id: string, title: string, pace?: number, schemas: Record<string, unknown>, input?: object, build: Function }>} */
const scenarios = [
  // ── 1. Smithering (abbreviated full-build — still dense) ───────────────
  {
    id: "smithering",
    title: "full-build outline twin (dense phases + fan-outs)",
    pace: 0.85,
    schemas: {
      setup: out,
      route: out,
      preflight: out,
      intake: out,
      brainstorm: out,
      research: out,
      questions: out,
      answers: out,
      prd: out,
      design: out,
      eng: out,
      probe: out,
      tickets: out,
      scaffold: out,
      review: out,
      report: out,
      delivery: out,
      output: out,
    },
    build({ outputs, pacing, fable, sonnet, codex }) {
      return createElement(
        Workflow,
        { name: "smithering" },
        createElement(
          Sequence,
          null,
          detTask("setup", "Setup", outputs.setup, { summary: "setup", ok: true }),
          agentTask("route", "Route", outputs.route, sonnet("route", "routing…\n", pacing)),
          detTask("preflight", "Preflight", outputs.preflight, { summary: "ok", ok: true }),
          agentTask("intake", "Intake", outputs.intake, fable("intake", "intake…\n", pacing)),
          agentTask("brainstorm", "Brainstorm", outputs.brainstorm, fable("brainstorm", "brainstorm…\n", pacing)),
          createElement(
            Parallel,
            { maxConcurrency: 2 },
            agentTask("research:domain", "Research · domain", outputs.research, sonnet("r-dom", "domain…\n", pacing)),
            agentTask(
              "research:prior-art",
              "Research · prior art",
              outputs.research,
              sonnet("r-art", "prior art…\n", pacing),
            ),
          ),
          agentTask("questions", "Questions", outputs.questions, fable("q", "questions…\n", pacing)),
          detTask("answers", "Answers", outputs.answers, { summary: "auto", ok: true }),
          agentTask("prd", "PRD", outputs.prd, fable("prd", "prd…\n", pacing)),
          agentTask("design:draft", "Design · draft", outputs.design, sonnet("d-draft", "design…\n", pacing)),
          agentTask("design:review", "Design · review", outputs.design, fable("d-rev", "design review…\n", pacing)),
          agentTask("eng:doc", "Eng doc", outputs.eng, fable("eng", "eng doc…\n", pacing)),
          agentTask("eng:review", "Eng · review", outputs.eng, codex("eng-rev", "eng review…\n", pacing)),
          createElement(
            Parallel,
            { maxConcurrency: 3 },
            agentTask("probe:a1", "Probe · a1", outputs.probe, sonnet("p1", "probe1…\n", pacing)),
            agentTask("probe:a2", "Probe · a2", outputs.probe, sonnet("p2", "probe2…\n", pacing)),
            agentTask("probe:a3", "Probe · a3", outputs.probe, sonnet("p3", "probe3…\n", pacing)),
          ),
          agentTask("tickets", "Tickets", outputs.tickets, fable("tix", "tickets…\n", pacing)),
          agentTask("wf:scaffold", "WF · scaffold", outputs.scaffold, fable("scaf", "scaffold…\n", pacing)),
          createElement(
            Parallel,
            { maxConcurrency: 3 },
            agentTask("review:fable", "Review · fable", outputs.review, fable("rf", "fable review…\n", pacing)),
            agentTask("review:codex", "Review · codex", outputs.review, codex("rc", "codex review…\n", pacing)),
            agentTask("review:fast", "Review · fast", outputs.review, sonnet("rfast", "fast review…\n", pacing)),
          ),
          agentTask("report:final", "Report · final", outputs.report, fable("rep", "report…\n", pacing)),
          agentTask("delivery", "Delivery", outputs.delivery, fable("del", "delivery…\n", pacing)),
          detTask("output", "Output", outputs.output, { summary: "delivered", ok: true }),
        ),
      );
    },
  },

  // ── 2. Mission ─────────────────────────────────────────────────────────
  {
    id: "mission",
    title: "mission: plan → approve → execute → final",
    pace: 1.1,
    schemas: {
      plan: out,
      gate: out,
      execute: out,
      final: out,
    },
    build({ outputs, pacing, fable, sonnet }) {
      return createElement(
        Workflow,
        { name: "mission" },
        createElement(
          Sequence,
          null,
          agentTask("mission:plan", "Mission · plan", outputs.plan, fable("m-plan", "planning mission…\n", pacing)),
          // Auto-approved gate stand-in (deterministic)
          detTask("mission:approve-plan", "Approve plan", outputs.gate, {
            summary: "auto-approved",
            ok: true,
          }),
          agentTask(
            "mission:execute",
            "Mission · execute",
            outputs.execute,
            sonnet("m-exec", "executing mission…\n", pacing),
          ),
          agentTask("mission:final", "Mission · final", outputs.final, fable("m-final", "mission report…\n", pacing)),
        ),
      );
    },
  },

  // ── 3. Issues / plan-implement-review ───────────────────────────────────
  {
    id: "issues",
    title: "issues: discover → groups → plan/impl/review fan-out → PR",
    pace: 1.0,
    schemas: {
      discover: out,
      group: out,
      plan: out,
      implement: out,
      validate: out,
      review: out,
      pr: out,
      summary: out,
    },
    build({ outputs, pacing, fable, sonnet, codex, gemini }) {
      return createElement(
        Workflow,
        { name: "plan-implement-review-issues" },
        createElement(
          Sequence,
          null,
          agentTask("discover", "Discover issues", outputs.discover, fable("disc", "listing issues…\n", pacing)),
          agentTask("group", "Group work items", outputs.group, fable("grp", "grouping…\n", pacing)),
          // Two PR groups in parallel (typical multi-issue shape)
          createElement(
            Parallel,
            { maxConcurrency: 2 },
            createElement(
              Sequence,
              null,
              agentTask("g1:plan", "G1 · plan", outputs.plan, fable("g1p", "plan group1…\n", pacing)),
              agentTask("g1:implement", "G1 · implement", outputs.implement, codex("g1i", "impl hard…\n", pacing)),
              agentTask("g1:validate", "G1 · validate", outputs.validate, sonnet("g1v", "validate g1…\n", pacing)),
              createElement(
                Parallel,
                { maxConcurrency: 3 },
                agentTask("g1:review:claude", "G1 · review claude", outputs.review, fable("g1rc", "review…\n", pacing)),
                agentTask("g1:review:codex", "G1 · review codex", outputs.review, codex("g1rx", "review…\n", pacing)),
                agentTask(
                  "g1:review:gemini",
                  "G1 · review gemini",
                  outputs.review,
                  gemini("g1rg", "review…\n", pacing),
                ),
              ),
              agentTask("g1:pr", "G1 · open PR", outputs.pr, sonnet("g1pr", "pr…\n", pacing)),
            ),
            createElement(
              Sequence,
              null,
              agentTask("g2:plan", "G2 · plan", outputs.plan, fable("g2p", "plan group2…\n", pacing)),
              agentTask("g2:implement", "G2 · implement", outputs.implement, gemini("g2i", "impl easy…\n", pacing)),
              agentTask("g2:validate", "G2 · validate", outputs.validate, sonnet("g2v", "validate g2…\n", pacing)),
              agentTask("g2:review:claude", "G2 · review", outputs.review, fable("g2r", "review g2…\n", pacing)),
              agentTask("g2:pr", "G2 · open PR", outputs.pr, sonnet("g2pr", "pr…\n", pacing)),
            ),
          ),
          agentTask("summary", "Campaign summary", outputs.summary, fable("sum", "summary…\n", pacing)),
        ),
      );
    },
  },

  // ── 4. Implement ───────────────────────────────────────────────────────
  {
    id: "implement",
    title: "implement → validate → polish",
    pace: 1.25,
    schemas: {
      implement: out,
      validate: out,
      polish: out,
      output: out,
    },
    build({ outputs, pacing, fable, sonnet, codex }) {
      return createElement(
        Workflow,
        { name: "implement" },
        createElement(
          Sequence,
          null,
          agentTask("implement", "Implement", outputs.implement, codex("impl", "implementing…\n", pacing)),
          agentTask("validate", "Validate", outputs.validate, sonnet("val", "validating…\n", pacing)),
          agentTask("impl:polish", "Polish", outputs.polish, fable("pol", "polishing…\n", pacing)),
          detTask("output", "Output", outputs.output, { summary: "done", ok: true }),
        ),
      );
    },
  },

  // ── 5. Open code review ────────────────────────────────────────────────
  {
    id: "code-review",
    title: "open-code-review: prepare → panel → summary",
    pace: 1.15,
    schemas: {
      target: out,
      preview: out,
      prepare: out,
      review: out,
      summary: out,
    },
    build({ outputs, pacing, fable, sonnet, codex }) {
      return createElement(
        Workflow,
        { name: "open-code-review" },
        createElement(
          Sequence,
          null,
          detTask("resolve-target", "Resolve target", outputs.target, {
            summary: "HEAD~3..HEAD",
            ok: true,
          }),
          detTask("preview", "Preview diff", outputs.preview, {
            summary: "12 files",
            ok: true,
          }),
          agentTask("prepare-review", "Prepare review", outputs.prepare, sonnet("prep", "preparing…\n", pacing)),
          createElement(
            Parallel,
            { maxConcurrency: 3 },
            agentTask("review:claude", "Review · claude", outputs.review, fable("rc", "claude review…\n", pacing)),
            agentTask("review:codex", "Review · codex", outputs.review, codex("rx", "codex review…\n", pacing)),
            agentTask("review:fast", "Review · fast", outputs.review, sonnet("rf", "fast review…\n", pacing)),
          ),
          agentTask("summary", "Review summary", outputs.summary, fable("sum", "synthesizing…\n", pacing)),
        ),
      );
    },
  },

  // ── 6. Hello (baseline) ────────────────────────────────────────────────
  {
    id: "hello",
    title: "single-agent hello (baseline)",
    pace: 1.5,
    schemas: { greet: out, output: out },
    build({ outputs, pacing, sonnet }) {
      return createElement(
        Workflow,
        { name: "hello" },
        createElement(
          Sequence,
          null,
          agentTask("greet", "Greet", outputs.greet, sonnet("hi", "hello…\n", pacing)),
          detTask("output", "Output", outputs.output, { summary: "hello world", ok: true }),
        ),
      );
    },
  },

  // ── 7. Loop (supervisor iter N) ────────────────────────────────────────
  // Same node id across iterations; supervisor should show `iter 2`, `iter 3`, …
  // on the body phase while the loop is live, then settle on final iter.
  {
    id: "loop",
    title: "loop body ×4 then done (iter badge vibe-check)",
    pace: 1.35,
    schemas: {
      setup: out,
      body: z.object({
        summary: z.string(),
        ok: z.boolean().default(true),
        done: z.boolean().default(false),
      }),
      after: out,
      output: out,
    },
    /** @param {any} api */
    buildWithCtx(api, pacing) {
      const { smithers, outputs } = api;
      let call = 0;
      const loopAgent = {
        id: "loop-body",
        model: "claude-sonnet-5",
        cliEngine: "claude-code",
        tools: {},
        supportsNativeStructuredOutput: true,
        async generate(args = {}) {
          const min = pacing.minMs;
          const max = Math.max(min, pacing.maxMs);
          await clock.sleep(min + Math.floor(Math.random() * (max - min + 1)));
          const i = call++;
          const done = i >= 3;
          const line = `[loop] body call=${i} done=${done}\n`;
          if (typeof args.onStdout === "function") args.onStdout(line);
          return {
            output: { summary: `iter-${i}`, ok: true, done },
            text: line,
          };
        },
      };
      return smithers((ctx) => {
        const latest = ctx.latest("body", "body");
        return createElement(
          Workflow,
          { name: "loop-demo" },
          createElement(
            Sequence,
            null,
            detTask("setup", "Setup", outputs.setup, { summary: "loop demo", ok: true }),
            createElement(
              Loop,
              {
                id: "loop",
                until: latest?.done === true,
                maxIterations: 6,
              },
              createElement(
                Task,
                {
                  id: "body",
                  label: "Loop body",
                  output: outputs.body,
                  agent: loopAgent,
                  retries: 0,
                },
                "loop body",
              ),
            ),
            agentTask("after", "After loop", outputs.after, sonnet("after", "after loop…\n", pacing)),
            detTask("output", "Output", outputs.output, {
              summary: "loop complete",
              ok: true,
            }),
          ),
        );
      });
    },
  },
];

// ── Run ──────────────────────────────────────────────────────────────────────
const list = only ? scenarios.filter((s) => only.has(s.id)) : scenarios;
if (only) {
  const known = new Set(scenarios.map((scenario) => scenario.id));
  const unknown = [...only].filter((id) => !known.has(id));
  if (unknown.length) throw new TypeError(`Unknown SMITHERS_OUTLINE_ONLY id(s): ${unknown.join(", ")}`);
}

console.log(`[outline-campaign] db=${dbPath}`);
console.log(`[outline-campaign] pacing=${pacingMode}  scenarios=${list.map((s) => s.id).join(",")}`);
console.log(`[outline-campaign] watch: bun apps/cli/src/index.js top --db ${dbPath}`);
console.log(`[outline-campaign] pause between=${pauseMs}ms`);

const results = [];
for (let i = 0; i < list.length; i++) {
  const r = await runOne(list[i]);
  results.push(r);
  if (i < list.length - 1 && pauseMs > 0) {
    console.log(`[outline-campaign] … pause ${pauseMs}ms (switch runs with [ ] in top)`);
    await sleep(pauseMs);
  }
}

const ok = results.filter((r) => r.ok).length;
console.log(`\n[outline-campaign] done ${ok}/${results.length} ok`);
for (const r of results) {
  console.log(`  ${r.ok ? "✓" : "✗"} ${r.id}  ${r.runId}${r.sec ? `  ${r.sec}s` : ""}${r.error ? `  ${r.error}` : ""}`);
}
// createSmithers / Effect leave open handles (sqlite, log fibers) that keep the
// event loop alive for ~30s+ after the last run finishes. Force exit so the
// campaign CLI returns as soon as the summary is printed.
process.exit(ok === results.length ? 0 : 1);
