// smithers-source: user
/** @jsxImportSource smithers-orchestrator */
import { Loop, Parallel, Sequence, Task, type AgentLike } from "smithers-orchestrator";
import { z } from "zod/v4";

// Absorb transient provider rate-limits (429s from bursting fable agents look
// like AGENT_QUOTA_EXCEEDED). Exponential backoff from 10s → ~5 min total, so a
// short rate-limit window clears rather than turning a harden step into a
// permanent continueOnFail failure (= empty coverage for that group).
const LOOP_RETRIES = 6;
const LOOP_RETRY_POLICY = { backoff: "exponential", initialDelayMs: 10_000 } as const;

/**
 * <TestFortress> — debate-hardened test coverage for one code path.
 *
 * For every feature group we run a bounded loop:
 *
 *   harden ──▶ gap ──▶ (proposer ‖ opponent) ──▶ judge
 *     ▲                                             │
 *     └────────────── verdict = "substantial" ──────┘
 *
 * 1. `harden`  — an implementer adds the strongest missing tests for the group.
 * 2. `gap`     — a reviewer is FORCED to name the single most valuable test that
 *                is still missing (it never returns "coverage is complete").
 * 3. debate    — a proposer argues that gap is trivial / already covered, an
 *                opponent argues it is substantial (a real hole).
 * 4. `judge`   — an impartial judge rules the gap `trivial` or `substantial`.
 *
 * The loop ends only when the judge rules the outstanding gap `trivial`
 * (coverage is good enough that the remaining gap is not worth a test), or when
 * `maxRounds` is reached. This is the {@link file://examples/debate.jsx} pattern
 * used as the stop condition for a coverage loop.
 *
 * Data flows between steps via `ctx.latest` (latest row) rather than
 * `needs`/`deps`. `<Sequence>` guarantees ordering; the workflow re-renders each
 * frame, so each task's prompt is rebuilt with the freshest upstream output
 * before it runs. This deliberately avoids `needs`/`deps` so a `continueOnFail`
 * upstream failure can never dangle a dependency into DEPENDENCY_DEADLOCK.
 */

export const tfHardenSchema = z.object({
  summary: z.string(),
  codePaths: z.array(z.string()).default([]),
  testFilesTouched: z.array(z.string()).default([]),
  testsAdded: z.number().int().default(0),
  allTestsPassing: z.boolean().default(false),
  verificationEvidence: z.array(z.string()).default([]),
});

export const tfGapSchema = z.object({
  // The reviewer MUST always name a missing test — this is never empty.
  missingTest: z.string(),
  codePath: z.string(),
  category: z.enum([
    "boundary",
    "smallest-input",
    "largest-input",
    "defensive-bound",
    "loop-or-recursion-limit",
    "parameter-combination",
    "error-path",
    "other",
  ]),
  rationale: z.string(),
  reviewerSeverity: z.enum(["trivial", "minor", "major", "critical"]),
});

export const tfArgSchema = z.object({
  position: z.enum(["trivial", "substantial"]),
  points: z.array(z.object({ claim: z.string(), evidence: z.string() })).default([]),
  summary: z.string(),
});

export const tfVerdictSchema = z.object({
  verdict: z.enum(["trivial", "substantial"]),
  reasoning: z.string(),
  recommendation: z.string(),
});

type TrackKind = "unit" | "e2e";

type FortressOutputs = {
  tfHarden: typeof tfHardenSchema;
  tfGap: typeof tfGapSchema;
  tfArg: typeof tfArgSchema;
  tfVerdict: typeof tfVerdictSchema;
};

type FortressCtx = {
  latest: (channel: unknown, nodeId: string) => unknown;
};

export type FeatureWorkItem = { name: string; features: string[] };

type TestFortressTrackProps = {
  ctx: FortressCtx;
  outputs: FortressOutputs;
  track: TrackKind;
  groups: FeatureWorkItem[];
  implementAgent: AgentLike | AgentLike[];
  reviewAgent: AgentLike | AgentLike[];
  debateAgent: AgentLike | AgentLike[];
  judgeAgent: AgentLike | AgentLike[];
  maxRounds?: number;
  maxConcurrency?: number;
};

function slug(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "item"
  );
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(36).slice(0, 8);
}

function bounded(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function trackFocus(track: TrackKind): string {
  return track === "unit"
    ? [
        "TRACK: UNIT TESTS ONLY.",
        "Write fast, isolated, deterministic unit tests that exercise the function/module directly.",
        "Do NOT stand up servers, spawn agents, or hit the network. No real backends.",
      ].join("\n")
    : [
        "TRACK: END-TO-END + INTEGRATION TESTS ONLY.",
        "Write tests that drive the REAL code path across module boundaries (real backend, real gateway/DB, real CLI/process where applicable).",
        "NO MOCKS: no mockGateway, no page.route/routeWebSocket data fabrication, no hardcoded stand-ins.",
        "Seed real fixtures with deterministic data; deliberate failure-injection against a real fault path is allowed.",
      ].join("\n");
}

function featureList(group: FeatureWorkItem): string[] {
  return group.features.map((f) => `- ${f}`);
}

function hardenPrompt(props: {
  track: TrackKind;
  group: FeatureWorkItem;
  priorGap: z.infer<typeof tfGapSchema> | undefined;
  priorVerdict: z.infer<typeof tfVerdictSchema> | undefined;
}): string {
  const { track, group, priorGap, priorVerdict } = props;
  const priorSubstantial =
    priorVerdict?.verdict === "substantial" && priorGap
      ? [
          "",
          "A prior review round found a NON-TRIVIAL missing test that you MUST now add:",
          `- Missing test: ${priorGap.missingTest}`,
          `- Code path: ${priorGap.codePath}`,
          `- Category: ${priorGap.category}`,
          `- Judge reasoning: ${priorVerdict.reasoning}`,
          `- Judge recommendation: ${priorVerdict.recommendation}`,
          "Close THIS gap first, then look for any others.",
        ].join("\n")
      : "";

  return [
    `# Harden test coverage for feature group ${group.name}`,
    "",
    trackFocus(track),
    "",
    "Features in this group (find their real code paths in the repo and cover them):",
    ...featureList(group),
    "",
    "Add HIGH-VALUE tests only. Do NOT add tests that duplicate coverage that already exists.",
    "Think hard about, and add tests for, whichever of these actually apply to this code:",
    "- Boundary conditions: the smallest output/collection we accept (0, empty, single) and the largest.",
    "- Defensive bounds: does the code reject or clamp an unreasonable input instead of blowing up? If it should and does not, add a test that pins the SHOULD (and note the bug).",
    "- Loops and recursion: is there a sane cap on iteration/depth before we fail loudly? Add tests that assert the limit and the failure mode when exceeded.",
    "- Untested parameter combinations: cross-products of options/flags/states not yet exercised.",
    "- Error paths: thrown/rejected/failed branches and their messages.",
    priorSubstantial,
    "",
    "Rules:",
    "- Keep product-code changes minimal; prefer adding tests. Only change product code to fix a real bug that blocks testing (and add the regression test).",
    "- Run the affected package's test suite and capture the commands + results in verificationEvidence.",
    "- Set allTestsPassing only if the suite you ran is green. List every test file you touched.",
  ]
    .filter(Boolean)
    .join("\n");
}

function gapPrompt(props: { track: TrackKind; group: FeatureWorkItem }): string {
  const { track, group } = props;
  return [
    `# Adversarial coverage review for feature group ${group.name}`,
    "",
    trackFocus(track),
    "",
    "You are a relentless reviewer. Your thesis is ALWAYS that coverage is insufficient.",
    "Read the code paths for these features and the tests that cover them:",
    ...featureList(group),
    "",
    "Return the SINGLE most valuable test that is still missing. You must always return one — never claim coverage is complete.",
    "Prefer, in order: unbounded loops/recursion with no failure cap, missing defensive bounds on inputs, the smallest and largest accepted output, untested parameter combinations, then error paths.",
    "Be concrete: name the exact file/function (codePath) and the precise assertion the missing test would make.",
    "Set reviewerSeverity honestly — even you may only be able to find a trivial gap once coverage is strong.",
  ].join("\n");
}

function argPrompt(props: {
  position: "trivial" | "substantial";
  group: FeatureWorkItem;
  gap: z.infer<typeof tfGapSchema> | undefined;
}): string {
  const { position, group, gap } = props;
  const stance =
    position === "trivial"
      ? "You argue the reviewer's missing test is TRIVIAL: already effectively covered, not reachable, or so low-value that adding it would be test-for-test's-sake."
      : "You argue the reviewer's missing test is SUBSTANTIAL: a real hole in coverage that a correctness/regression bug could slip through.";
  return [
    `# Debate the outstanding coverage gap for ${group.name}`,
    "",
    stance,
    "Read the actual code and existing tests before arguing — cite files and line-level evidence, not rhetoric.",
    "",
    "## The reviewer's proposed missing test",
    JSON.stringify(gap ?? null, null, 2),
    "",
    "Return your position, concrete points with evidence, and a one-line summary.",
  ].join("\n");
}

function judgePrompt(props: {
  group: FeatureWorkItem;
  gap: z.infer<typeof tfGapSchema> | undefined;
  forArg: z.infer<typeof tfArgSchema> | undefined;
  againstArg: z.infer<typeof tfArgSchema> | undefined;
}): string {
  const { group, gap, forArg, againstArg } = props;
  return [
    `# Judge the coverage gap for ${group.name}`,
    "",
    "You are an impartial judge. Rule whether the reviewer's outstanding missing test is `trivial` or `substantial`.",
    "Rule `trivial` ONLY if the gap is genuinely not worth a test: already covered in effect, unreachable, or vanishingly low value. When `trivial`, the coverage loop ENDS.",
    "Rule `substantial` if a real correctness/regression bug could slip through the gap. When `substantial`, the implementer will be sent back to add exactly this test.",
    "Weigh evidence quality, not rhetoric. Bias toward `substantial` when either side's evidence is thin — do not let a real hole through.",
    "",
    "## Reviewer's proposed missing test",
    JSON.stringify(gap ?? null, null, 2),
    "",
    "## Argument that it is TRIVIAL",
    JSON.stringify(forArg ?? null, null, 2),
    "",
    "## Argument that it is SUBSTANTIAL",
    JSON.stringify(againstArg ?? null, null, 2),
  ].join("\n");
}

export function TestFortressTrack({
  ctx,
  outputs,
  track,
  groups,
  implementAgent,
  reviewAgent,
  debateAgent,
  judgeAgent,
  maxRounds = 4,
  maxConcurrency = 3,
}: TestFortressTrackProps) {
  const rounds = bounded(maxRounds, 4);
  const concurrency = bounded(maxConcurrency, 3);
  const usedIds = new Set<string>();
  return (
    <Parallel maxConcurrency={concurrency}>
      {groups.map((group) => {
        const normalized = slug(group.name);
        let groupId = normalized;
        if (usedIds.has(groupId)) {
          const stem = `${normalized}-${stableHash(group.name)}`;
          groupId = stem;
          let disambiguator = 2;
          while (usedIds.has(groupId)) groupId = `${stem}-${disambiguator++}`;
        }
        usedIds.add(groupId);
        const base = `tf:${track}:${groupId}`;
        const hardenNode = `${base}:harden`;
        const gapNode = `${base}:gap`;
        const forNode = `${base}:for`;
        const againstNode = `${base}:against`;
        const judgeNode = `${base}:judge`;

        const gap = ctx.latest(outputs.tfGap, gapNode) as
          | z.infer<typeof tfGapSchema>
          | undefined;
        const forArg = ctx.latest(outputs.tfArg, forNode) as
          | z.infer<typeof tfArgSchema>
          | undefined;
        const againstArg = ctx.latest(outputs.tfArg, againstNode) as
          | z.infer<typeof tfArgSchema>
          | undefined;
        const verdict = ctx.latest(outputs.tfVerdict, judgeNode) as
          | z.infer<typeof tfVerdictSchema>
          | undefined;
        const trivial = verdict?.verdict === "trivial";

        return (
          <Loop
            key={base}
            id={`${base}:loop`}
            until={trivial}
            maxIterations={rounds}
            onMaxReached="return-last"
          >
            <Sequence>
              <Task
                id={hardenNode}
                output={outputs.tfHarden}
                agent={implementAgent}
                retries={LOOP_RETRIES}
                retryPolicy={LOOP_RETRY_POLICY}
                continueOnFail
                timeoutMs={90 * 60_000}
                heartbeatTimeoutMs={10 * 60_000}
              >
                {hardenPrompt({ track, group, priorGap: gap, priorVerdict: verdict })}
              </Task>

              <Task
                id={gapNode}
                output={outputs.tfGap}
                agent={reviewAgent}
                retries={LOOP_RETRIES}
                retryPolicy={LOOP_RETRY_POLICY}
                continueOnFail
                timeoutMs={30 * 60_000}
                heartbeatTimeoutMs={10 * 60_000}
              >
                {gapPrompt({ track, group })}
              </Task>

              <Parallel>
                <Task
                  id={forNode}
                  output={outputs.tfArg}
                  agent={debateAgent}
                  retries={LOOP_RETRIES}
                retryPolicy={LOOP_RETRY_POLICY}
                  continueOnFail
                  timeoutMs={20 * 60_000}
                  heartbeatTimeoutMs={10 * 60_000}
                >
                  {argPrompt({ position: "trivial", group, gap })}
                </Task>
                <Task
                  id={againstNode}
                  output={outputs.tfArg}
                  agent={debateAgent}
                  retries={LOOP_RETRIES}
                retryPolicy={LOOP_RETRY_POLICY}
                  continueOnFail
                  timeoutMs={20 * 60_000}
                  heartbeatTimeoutMs={10 * 60_000}
                >
                  {argPrompt({ position: "substantial", group, gap })}
                </Task>
              </Parallel>

              <Task
                id={judgeNode}
                output={outputs.tfVerdict}
                agent={judgeAgent}
                retries={LOOP_RETRIES}
                retryPolicy={LOOP_RETRY_POLICY}
                continueOnFail
                timeoutMs={20 * 60_000}
                heartbeatTimeoutMs={10 * 60_000}
              >
                {judgePrompt({ group, gap, forArg, againstArg })}
              </Task>
            </Sequence>
          </Loop>
        );
      })}
    </Parallel>
  );
}
