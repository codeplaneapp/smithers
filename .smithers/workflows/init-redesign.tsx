// smithers-source: authored
// smithers-display-name: Init Redesign
// smithers-description: Implements the interactive `smithers init` redesign end-to-end — never-fail default agent, OpenRouter, a-la-carte workflows/skills, non-interactive escape, make-workflow builder, OpenTUI spike, and the make-workflow tutorial — driving each workstream through an implement→check loop, then a full-suite gate loop, then review.
// smithers-tags: meta, dogfood, init, redesign
/** @jsxImportSource smithers-orchestrator */
import { $ } from "bun";
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import { Review, reviewOutputSchema } from "../components/Review";

const REPO = "/Users/williamcory/smithers3";
const SYNTHESIS = "/private/tmp/claude-501/-Users-williamcory-smithers3/9849fcba-2c3c-4fbb-ae7b-69bb6359d76d/scratchpad/init-redesign-research-synthesis.md";
const SPEC = "/private/tmp/claude-501/-Users-williamcory-smithers3/9849fcba-2c3c-4fbb-ae7b-69bb6359d76d/scratchpad/init-redesign-spec.md";

/** Shared preamble every implement/fix agent receives. */
const SHARED_CONTEXT = [
  "You are implementing the interactive `smithers init` redesign in the smithers monorepo at " + REPO + ".",
  "",
  "READ THESE FIRST (they hold the full plan + exact file paths + gotchas):",
  "  - " + SPEC + "  (the locked product spec)",
  "  - " + SYNTHESIS + "  (research synthesis: reuse targets, blockers, file paths, line numbers)",
  "",
  "LOCKED DECISIONS:",
  "  - Interactive by DEFAULT, with a robust non-interactive escape (an agent/CI must never hang).",
  "  - Never fail when no agent is detected: emit agents.ts with ALL agents, commenting out the unavailable ones,",
  "    and a default AI SDK agent (reuse OpenAIAgent pointed at OpenRouter). v1 = scaffold + LOUD actionable first-run",
  "    error if creds/tools are missing (do NOT wire a toolset in v1).",
  "  - Detect OpenRouter via OPENROUTER_API_KEY.",
  "  - Let the user CHOOSE which workflows to install (a-la-carte) and which skills/CLAUDE.md edits to apply",
  "    (multiselect, ALL checked by default).",
  "  - Getting-started verb is `make-workflow \"task\"`; `init \"task\"` runs the same builder (reuse .smithers/workflows/create-workflow.tsx). `/goal` is retired (it collides with Codex).",
  "  - UI: OpenTUI is a NEW dependency — spike it first. If the spike proves it installs+renders under Bun, build the",
  "    interactive UI on OpenTUI; otherwise fall back to @clack/prompts (already a dep; has multiselect).",
  "",
  "HARD RULES:",
  "  - Keep the gate GREEN: `pnpm typecheck` and `pnpm -C apps/cli test` must pass; do not break .smithers tsc (init.e2e + ci.yml gate the generated agents.ts).",
  "  - NO MOCKS in product code or e2e (see CLAUDE.md). Add real tests for what you build.",
  "  - This is a jj colocated repo shared with other agents: commit with EXPLICIT pathspecs (never `git add -A`). Atomic emoji+conventional commits. Do NOT push.",
  "  - Match surrounding code style. Reuse what already exists (OpenAIAgent, create-workflow.tsx, smithering.tsx, _sessionFileResolvers.js, clack multiselect) instead of rebuilding.",
].join("\n");

/** A workstream's implementation instruction (focused; the agent reads the spec/synthesis for detail). */
function wsPrompt(body: string, failing: string | null): string {
  return [
    SHARED_CONTEXT,
    "",
    "=== YOUR WORKSTREAM ===",
    body,
    failing ? "\n=== PREVIOUS CHECK FAILED — FIX THIS ===\n" + failing : "",
    "\nWhen done, run the relevant checks yourself, then make an atomic commit (explicit pathspecs).",
  ].join("\n");
}

const implSchema = z.looseObject({
  summary: z.string(),
  filesChanged: z.array(z.string()).default([]),
  committed: z.boolean().default(false),
});

const checkSchema = () =>
  z.looseObject({
    ok: z.boolean().default(false),
    summary: z.string().default(""),
    failing: z.string().nullable().default(null),
  });

const spikeSchema = z.looseObject({
  viable: z.boolean().default(false),
  notes: z.string().default(""),
});

const outputSchema = z.object({
  status: z.string(),
  summary: z.string(),
  gateGreen: z.boolean().default(false),
});

/**
 * Each workstream: a focused implement target + the deterministic checks that
 * gate its loop. `cmds` run from REPO; the loop exits when all exit 0.
 */
const WORKSTREAMS: { key: string; title: string; body: string; cmds: string[] }[] = [
  {
    key: "agents",
    title: "Never-fail agents.ts + AI SDK default + OpenRouter + comment-out-unavailable",
    body: [
      "Rewrite apps/cli/src/agent-detection.js so generateAgentsTs NEVER throws NO_USABLE_AGENTS.",
      "- Add an OpenRouter detector (OPENROUTER_API_KEY) and a default AI SDK agent built from OpenAIAgent",
      "  ({ model: <baked tool/json-capable model id>, baseURL: \"https://openrouter.ai/api/v1\", apiKey: process.env.OPENROUTER_API_KEY }).",
      "- Emit ALL known agents into agents.ts, prefixing UNAVAILABLE ones (provider line + its import + export + scaffold ref + every pool membership) with `// ` ATOMICALLY so the file still typechecks (the `as const satisfies Record<string,AgentLike[]>` and tsc gate in init.e2e + ci.yml MUST pass; active pools reference only active providers).",
      "- The default agent must be a real detector + CONSTRUCTORS entry so extractGeneratedDetectionProviderIds round-trips it (a plain ad-hoc line gets dropped by `agent add`).",
      "- Replace both NO_USABLE_AGENTS throws with the default-agent fallback. v1: if no credentials, the agent is still emitted but its first RUN errors loudly with an actionable message — do NOT block init.",
      "- Add regression tests in apps/cli/tests (generate with no CLI binaries → assert AI SDK default is active in smart/smartTool, unavailable providers appear only as commented lines, and a generate→extractGeneratedDetectionProviderIds→generate round-trip keeps the default + commented set stable).",
    ].join("\n"),
    cmds: [
      "pnpm -C apps/cli test 2>&1 | tail -40",
      "pnpm --filter ./.smithers typecheck 2>&1 | tail -20",
    ],
  },
  {
    key: "noninteractive",
    title: "Interactive-by-default with a robust non-interactive escape",
    body: [
      "Add a `resolveInitMode(c, env)` predicate (in apps/cli/src/init-command.js or a shared util) that returns interactive ONLY when ALL hold:",
      "  stdin.isTTY && stdout.isTTY && !--json/--format && !--yes && !SMITHERS_NONINTERACTIVE && !SMITHERS_YES && !isCI(env) && !isAgentHarness(env) && TERM!=='dumb'.",
      "- Add a `--yes`/`--non-interactive` flag to initOptions (copy rewind.js semantics).",
      "- Add shared isCI (CI/GITHUB_ACTIONS/GITLAB_CI/BUILDKITE/CIRCLECI/TF_BUILD…) and isAgentHarness (CLAUDECODE/CLAUDE_CODE_ENTRYPOINT, read EARLY before any agent clears them) helpers.",
      "- Non-interactive ⇒ the existing structured initWorkflowPack path with sane defaults (default AI SDK agent, all workflows, all skills) and NEVER a prompt/TUI.",
      "- Update skills/smithers/SKILL.md so the agent-run example is `smithers init --yes` (or sets SMITHERS_NONINTERACTIVE=1).",
      "- Add tests asserting each non-interactive signal forces the structured path.",
    ].join("\n"),
    cmds: ["pnpm -C apps/cli test 2>&1 | tail -40", "pnpm typecheck 2>&1 | tail -20"],
  },
  {
    key: "alacarte",
    title: "Choose which workflows to install (a-la-carte)",
    body: [
      "In apps/cli/src/workflow-pack.js introduce an explicit WORKFLOW_MANIFEST (each {id, file, ui, components[], prompts[]}) as the single source of truth, plus a dependency-closure resolver (ValidationLoop→Review, component→its prompts).",
      "- Add `selectedWorkflows?: string[]` to InitOptions; gate workflow/component/prompt/ui emission AND gateway mounts (UI_WORKFLOWS/renderGatewayFile) through the closure. Default = all ids ⇒ byte-identical to today.",
      "- Always emit infra files. Keep the two drift tests green (make them selection-aware).",
      "- Add a test: selecting a subset installs exactly that subset + its transitive deps + infra, and the gateway mount list matches.",
    ].join("\n"),
    cmds: ["pnpm -C apps/cli test 2>&1 | tail -40"],
  },
  {
    key: "skills",
    title: "Select which skills to install / which agent docs to edit (multiselect, all checked)",
    body: [
      "Make skill install + CLAUDE.md/AGENTS.md edits per-item selectable.",
      "- Refactor installCuratedSkill to accept a filtered target list; refactor noteWorkflowPreferenceInAgentDocs to accept the specific selected filenames (noteOne is the per-file primitive).",
      "- Plumb `selectedSkillTargets`/`selectedAgentDocs` through initWorkflowPack. Non-interactive defaults = all.",
      "- Persist deselections (e.g. ~/.smithers/skill-refresh.json marker) so refreshCuratedSkills does not re-add a deselected agent on upgrade.",
      "- Tests for filtered install + the persisted opt-out.",
    ].join("\n"),
    cmds: ["pnpm -C apps/cli test 2>&1 | tail -40"],
  },
  {
    key: "makeworkflow",
    title: "make-workflow command + `init [optional prompt]` builder",
    body: [
      "Add a top-level `make-workflow [task]` command and an optional positional `prompt` to `init`, both dispatching to the existing .smithers/workflows/create-workflow.tsx builder (reuse resolveWorkflow/executeUpCommand/runTuiCommand; honor the interactive vs --yes/--json split).",
      "- `init \"task\"` ⇒ install pack (if needed) then run the builder with the prompt prefilled.",
      "- `make-workflow \"task\"` ⇒ resolve create-workflow and run with the prompt prefilled.",
      "- Register the command in apps/cli/src/index.js; add help text; add a test that the command resolves and forwards the prompt.",
    ].join("\n"),
    cmds: ["pnpm -C apps/cli test 2>&1 | tail -40", "pnpm typecheck 2>&1 | tail -20"],
  },
  {
    key: "interactive",
    title: "The interactive init flow (OpenTUI if the spike is viable, else clack multiselect)",
    body: [
      "Build the interactive init experience gated behind resolveInitMode. Read the spike result: if OpenTUI is viable build the UI on @opentui/react; otherwise build it on @clack/prompts `multiselect` (already installed).",
      "Steps to prompt (defaults preselected): (1) agent setup — when none detected, let the user pick a provider / API key (incl. OpenRouter) or scaffold a custom AgentLike adapter (the prompt must explain the `generate()` contract); (2) a-la-carte workflow multiselect; (3) skills + CLAUDE.md multiselect (all checked). Feed selections into initWorkflowPack.",
      "Wire it into runInitCommand/initCeremony so the interactive branch PROMPTS before initWorkflowPack, and the non-interactive branch keeps the structured path. STRETCH (only if cheap & safe): load the interactive flow as a bundled smithers workflow (apps/cli/src/init/*.tsx via import.meta.url) so init is itself a smithers workflow — otherwise leave a clear TODO and keep it imperative.",
      "Because this path needs a TTY, do not assert it in headless e2e; unit-test the selection-to-options mapping instead and keep typecheck/tests green.",
    ].join("\n"),
    cmds: ["pnpm typecheck 2>&1 | tail -20", "pnpm -C apps/cli test 2>&1 | tail -40"],
  },
  {
    key: "tutorial",
    title: "make-workflow tutorial: scan repo + external chats → recommend → build UI → run/monitor/improve; + dive-deeper docs preview",
    body: [
      "Author a seeded smithers workflow (e.g. .smithers/workflows/make-workflow-tutorial.tsx) + its prompts that, for a FIRST-TIME user (no prior smithers runs):",
      "  1. reads smithers docs, the code repo (reuse the sync-features.tsx bootstrap find/grep shell-out), and the user's EXTERNAL coding-agent chat sessions (build a read-only reader on top of apps/observability/src/_sessionFileResolvers.js: enumerate ~/.claude/projects/*.jsonl, ~/.codex/sessions + history.jsonl, ~/.pi/agent/sessions; extract user/assistant text per agent schema; reuse redactValue; bounded reads).",
      "  2. recommends a RANKED LIST of candidate smithers workflows (model on route-task.tsx + repo-prospector.tsx schemas), user picks one.",
      "  3. hands the pick to create-workflow.tsx to build it AND a custom .smithers/ui/<id>.tsx, then launches + monitors + self-improves (reuse smithering.tsx/monitor.tsx), narrating updates.",
      "Also add a 'dive deeper' preview (model on smoketest.tsx) that reads the HUMAN docs (docs/guide/*.mdx 'You say → Smithers runs' tables) and shows features are invoked by prompting. Verify both render: `bunx smithers-orchestrator graph .smithers/workflows/make-workflow-tutorial.tsx`.",
    ].join("\n"),
    cmds: [
      "bunx smithers-orchestrator graph .smithers/workflows/make-workflow-tutorial.tsx 2>&1 | tail -30",
      "pnpm --filter ./.smithers typecheck 2>&1 | tail -20",
    ],
  },
];

/** Build the createSmithers step map: shared impl + spike + per-ws check schemas + gate/review/output. */
const stepDefs: Record<string, unknown> = {
  input: z.object({ prompt: z.string().default("Implement the smithers init redesign end-to-end.") }),
  impl: implSchema,
  spike: spikeSchema,
  gate: checkSchema(),
  review: reviewOutputSchema,
  output: outputSchema,
};
for (const ws of WORKSTREAMS) stepDefs[`check_${ws.key}`] = checkSchema();

const { Workflow, Task, Sequence, Branch, Loop, smithers, outputs } = createSmithers(stepDefs as any);

/** Run shell commands from REPO; ok iff all exit 0. Returns the first failure's tail. */
async function runChecks(cmds: string[]): Promise<{ ok: boolean; summary: string; failing: string | null }> {
  const done: string[] = [];
  for (const cmd of cmds) {
    const res = await $`bash -lc ${`cd ${REPO} && ${cmd}`}`.nothrow().quiet();
    const out = `${res.stdout?.toString() ?? ""}\n${res.stderr?.toString() ?? ""}`.trim();
    if (res.exitCode !== 0) {
      return { ok: false, summary: `FAILED: ${cmd}`, failing: `$ ${cmd}\n${out}`.slice(0, 8000) };
    }
    done.push(cmd);
  }
  return { ok: true, summary: `OK: ${done.length} check(s) passed`, failing: null };
}

export default smithers((ctx) => {
  const spike = ctx.outputMaybe("spike", { nodeId: "spike-opentui" });

  // Full-suite gate loop bookkeeping.
  const gateOutputs = ctx.outputs.gate ?? [];
  const lastGate = gateOutputs.at(-1);
  const gateGreen = lastGate?.ok === true;
  const reviews = ctx.outputs.review ?? [];
  const anyApproved = reviews.length > 0 && reviews.some((r: any) => r.approved === true);

  return (
    <Workflow name="init-redesign">
      <Sequence>
        {/* 0 — Spike: prove (or disprove) OpenTUI under Bun before any UI work. */}
        <Task id="spike-opentui" output={outputs.spike} agent={agents.smartTool} timeoutMs={1_800_000} heartbeatTimeoutMs={600_000}>
          {wsPrompt(
            [
              "OpenTUI viability spike. OpenTUI is NOT in the repo (no package.json, neither lockfile).",
              "- Pin `packageManager` in the root package.json to remove the bun/pnpm ambiguity.",
              "- Add @opentui/core + @opentui/react to apps/cli/package.json, install, and write a throwaway script that mounts a trivial component and renders it under Bun; also reason about whether it loads inside a packaged `bunx smithers-orchestrator`.",
              "- Output { viable: boolean, notes }. If native bindings fail under Bun, set viable=false with the error — the interactive workstream will fall back to clack.",
              "- Commit the dependency + packageManager pin atomically. Do NOT build the UI here.",
            ].join("\n"),
            null,
          )}
        </Task>

        {/* 1..N — Each workstream: implement → deterministic check, loop until green. */}
        {WORKSTREAMS.map((ws) => {
          const checkStep = `check_${ws.key}`;
          const checkOutputs = ctx.outputs[checkStep] ?? [];
          const last = checkOutputs.at(-1);
          const passed = last?.ok === true;
          const failing = last && last.ok === false ? last.failing : null;
          const extra =
            ws.key === "interactive" && spike
              ? `\n\nSPIKE RESULT: OpenTUI viable=${spike.viable}. ${spike.notes}`
              : "";
          return (
            <Loop key={ws.key} id={`${ws.key}:loop`} until={passed} maxIterations={3} onMaxReached="return-last">
              <Sequence>
                <Task
                  id={`${ws.key}:implement`}
                  output={outputs.impl}
                  agent={agents.smartTool}
                  timeoutMs={1_800_000}
                  heartbeatTimeoutMs={600_000}
                >
                  {wsPrompt(`${ws.title}\n\n${ws.body}${extra}`, failing)}
                </Task>
                <Task id={`${ws.key}:check`} output={outputs[checkStep]} timeoutMs={1_200_000}>
                  {async () => runChecks(ws.cmds)}
                </Task>
              </Sequence>
            </Loop>
          );
        })}

        {/* Integration gate — the real review loop: run the full suite, fix until green. */}
        <Loop id="gate:loop" until={gateGreen} maxIterations={6} onMaxReached="return-last">
          <Sequence>
            <Task id="gate:check" output={outputs.gate} timeoutMs={1_800_000}>
              {async () => runChecks(["pnpm typecheck 2>&1 | tail -40", "pnpm -C apps/cli test 2>&1 | tail -60"])}
            </Task>
            <Branch
              if={!gateGreen}
              then={
                <Task
                  id="gate:fix"
                  output={outputs.impl}
                  agent={agents.smartTool}
                  timeoutMs={1_800_000}
                  heartbeatTimeoutMs={600_000}
                >
                  {wsPrompt(
                    "Integration gate failing. The whole init redesign must pass `pnpm typecheck` and `pnpm -C apps/cli test`. Diagnose and fix the failures across any workstream without regressing the others. Add/repair tests as needed.",
                    lastGate?.failing ?? null,
                  )}
                </Task>
              }
              else={null}
            />
          </Sequence>
        </Loop>

        {/* Final review — multi-reviewer pass over the completed redesign. */}
        {gateGreen ? (
          <Review
            idPrefix="final-review"
            prompt="Review the smithers init redesign for completeness and correctness against the spec: never-fail default agent + OpenRouter + comment-out-unavailable, non-interactive escape, a-la-carte workflows, skills/CLAUDE.md multiselect, make-workflow + init [prompt], OpenTUI spike + interactive flow, and the make-workflow tutorial. Approve only if it is production-ready, tested, and the gate is green."
            agents={agents.cheapFast}
          />
        ) : null}

        {/* Terminal summary. */}
        <Task id="output" output={outputs.output}>
          {() => ({
            status: gateGreen ? (anyApproved ? "complete" : "gate-green-pending-review") : "in-progress",
            summary: gateGreen
              ? "Init redesign workstreams implemented; full gate green."
              : "Init redesign in progress.",
            gateGreen,
          })}
        </Task>
      </Sequence>
    </Workflow>
  );
});
