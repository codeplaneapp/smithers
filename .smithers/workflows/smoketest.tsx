// smithers-source: seeded
// smithers-metadata-version: 1
// smithers-display-name: Smoke Test
// smithers-description: Comprehensive release smoke test. Four parallel agents prove the published smithers-orchestrator works for a brand-new user: the human onboarding flow, the agent onboarding flow, every user-facing change across the last 4 releases, and a real workflow UI served over the gateway — then a deterministic report aggregates the verdict.
// smithers-tags: release, qa, smoke
/** @jsxImportSource smithers-orchestrator */
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import FeaturesPrompt from "../prompts/smoketest.mdx";
import HumanOnboardingPrompt from "../prompts/smoketest-onboarding-human.mdx";
import AgentOnboardingPrompt from "../prompts/smoketest-onboarding-agent.mdx";
import WorkflowUiPrompt from "../prompts/smoketest-ui.mdx";

/**
 * Resolve the monorepo root from this workflow file's location
 * (`<repo>/.smithers/workflows/smoketest.tsx`) so the smoke test always targets
 * the currently-checked-out version + ITS changelogs, not whatever npm
 * `@latest` happens to be. The smoke test runs the PUBLISHED package
 * (`bunx smithers-orchestrator@<version>`) in throwaway temp dirs; the repo is
 * only used to pin which version + docs are the source of truth.
 */
const workflowDir = fileURLToPath(new URL(".", import.meta.url).href);
const monorepoRoot = resolve(workflowDir, "../..");
const rootPkg = JSON.parse(
  readFileSync(resolve(monorepoRoot, "package.json"), "utf8"),
) as { version: string };
const CURRENT_VERSION = String(rootPkg.version);

// How many releases back to smoke-test. The user-facing surface changes across
// minor + patch releases, so a release smoke test that only reads the current
// changelog misses regressions reintroduced from two releases ago. Default 4.
const RELEASE_COUNT = 4;

const changelogsDir = resolve(monorepoRoot, "docs/changelogs");
const semverKey = (v: string): number => {
  const [a, b, c] = v.split(".").map((n) => Number.parseInt(n, 10));
  return a * 1_000_000 + b * 1_000 + c;
};
const ALL_VERSIONS = readdirSync(changelogsDir)
  .filter((f) => f.endsWith(".mdx"))
  .map((f) => f.replace(/\.mdx$/, ""))
  .filter((v) => /^\d+\.\d+\.\d+$/.test(v))
  .sort((a, b) => semverKey(b) - semverKey(a));
const VERSIONS = ALL_VERSIONS.slice(0, RELEASE_COUNT);
const VERSIONS_STR = VERSIONS.join(", ");
const CHANGELOGS = VERSIONS.map(
  (v) => `=== CHANGELOG ${v} ===\n\n${readFileSync(resolve(changelogsDir, `${v}.mdx`), "utf8")}`,
).join("\n\n");

// The human getting-started track and the agent skill, embedded so each
// onboarding agent walks the EXACT documented steps without needing repo access
// from its throwaway temp dir.
const readDoc = (rel: string): string =>
  `=== ${rel} ===\n\n${readFileSync(resolve(monorepoRoot, rel), "utf8")}`;
const HUMAN_GUIDE = ["docs/guide/get-started.mdx", "docs/quickstart.mdx", "docs/cli/quickstart.mdx"]
  .map(readDoc)
  .join("\n\n");
const AGENT_SKILL = readFileSync(resolve(monorepoRoot, "skills/smithers/SKILL.md"), "utf8");

const DEFAULT_PROMPT =
  "Smoke test the latest published smithers-orchestrator release against the pinned changelogs and onboarding docs.";

// One shape for every area's verdict AND the final aggregated report. `findings`
// carry a dotted `area` label (e.g. `features.migrate`, `human.run-hello`).
const smoketestOutputSchema = z.looseObject({
  passed: z.boolean(),
  summary: z.string(),
  findings: z
    .array(
      z.object({
        area: z.string(),
        status: z.enum(["pass", "fail", "skipped"]),
        evidence: z.string(),
      }),
    )
    .default([]),
  reproSteps: z.array(z.string()).default([]),
});

const inputSchema = z.object({
  prompt: z.string().default(DEFAULT_PROMPT),
  versions: z.string().default(VERSIONS_STR),
  changelogs: z.string().default(CHANGELOGS),
  humanGuide: z.string().default(HUMAN_GUIDE),
  agentSkill: z.string().default(AGENT_SKILL),
});

const { Workflow, Task, Sequence, Parallel, smithers, outputs } = createSmithers({
  input: inputSchema,
  area: smoketestOutputSchema,
  smoketest: smoketestOutputSchema,
});

/**
 * Comprehensive smoke test. Four independent agents each work in their OWN
 * fresh temp dir against the published `smithers-orchestrator@CURRENT_VERSION`,
 * so one area crashing can't poison another and `init` is exercised four times
 * (it is the single most important command). `continueOnFail` keeps a dead agent
 * from sinking the run; the deterministic report flags any missing area as a
 * failure. The agents are the only real dependency — everything they test is the
 * real published package.
 */
export default smithers((ctx) => {
  const prompt = ctx.input.prompt ?? DEFAULT_PROMPT;
  const versions = ctx.input.versions ?? VERSIONS_STR;
  const changelogs = ctx.input.changelogs ?? CHANGELOGS;
  const humanGuide = ctx.input.humanGuide ?? HUMAN_GUIDE;
  const agentSkill = ctx.input.agentSkill ?? AGENT_SKILL;

  return (
    <Workflow name="smoketest">
      <Sequence>
        <Parallel>
          {/* 1 — A brand-new HUMAN follows the "Get Started" / Quickstart track. */}
          <Task id="onboarding-human" output={outputs.area} agent={agents.midTier} continueOnFail>
            <HumanOnboardingPrompt version={CURRENT_VERSION} humanGuide={humanGuide} />
          </Task>

          {/* 2 — An AI agent is onboarded via the curated skill ("60 seconds to the aha"). */}
          <Task id="onboarding-agent" output={outputs.area} agent={agents.midTier} continueOnFail>
            <AgentOnboardingPrompt version={CURRENT_VERSION} agentSkill={agentSkill} />
          </Task>

          {/* 3 — Every user-facing change across the last RELEASE_COUNT releases. */}
          <Task id="features" output={outputs.area} agent={agents.midTier} continueOnFail>
            <FeaturesPrompt
              prompt={prompt}
              version={CURRENT_VERSION}
              versions={versions}
              changelogs={changelogs}
            />
          </Task>

          {/* 4 — A real workflow UI + gateway root routing, served over HTTP. */}
          <Task id="workflow-ui" output={outputs.area} agent={agents.midTier} continueOnFail>
            <WorkflowUiPrompt version={CURRENT_VERSION} />
          </Task>
        </Parallel>

        {/* 5 — Deterministic aggregation: an agent can't fake a green smoke test.
            passed only if all four areas reported AND none of their checks failed. */}
        <Task id="report" output={outputs.smoketest}>
          {() => {
            const rows = (ctx.outputs.area ?? []) as Array<z.infer<typeof smoketestOutputSchema>>;
            const findings = rows.flatMap((r) => r.findings ?? []);
            const reproSteps = rows.flatMap((r) => r.reproSteps ?? []);
            const failed = findings.filter((f) => f.status === "fail");
            const passed = rows.length === 4 && rows.every((r) => r.passed) && failed.length === 0;
            const summary =
              `Smoke test of smithers-orchestrator@${CURRENT_VERSION} across ${rows.length}/4 areas ` +
              `(changelogs: ${VERSIONS_STR}). ` +
              (passed
                ? "All baseline, onboarding, feature, and UI checks passed."
                : `${failed.length} failing check(s)${rows.length < 4 ? `; only ${rows.length}/4 areas reported` : ""}.`) +
              (rows.length ? ` ${rows.map((r) => r.summary).filter(Boolean).join(" ")}` : "");
            return { passed, summary, findings, reproSteps };
          }}
        </Task>
      </Sequence>
    </Workflow>
  );
});
