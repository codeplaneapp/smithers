// smithers-source: user
// smithers-display-name: Test Fortress
// smithers-description: Swarm features.ts for missing items, then debate-harden unit + e2e test coverage per feature until a judge rules every remaining gap trivial, then loop a Codex review until LGTM.
// smithers-tags: coding, tests, coverage, debate, codex, parallel
/** @jsxImportSource smithers-orchestrator */
import { Loop, Parallel, Sequence, Task, createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { providers } from "../agents";
import { FeatureGroups } from "../specs/features";
import {
  TestFortressTrack,
  tfArgSchema,
  tfGapSchema,
  tfHardenSchema,
  tfVerdictSchema,
  type FeatureWorkItem,
} from "../components/TestFortress";

const inputSchema = z.object({
  /** Only cover these feature groups (by name). Empty = all groups. */
  groups: z.array(z.string()).default([]),
  /** Cap the number of feature groups per track (0 = no cap / all). */
  limit: z.number().int().min(0).default(0),
  /** Fan-out width for the feature-discovery swarm. */
  discoveryAgents: z.number().int().min(1).max(16).default(8),
  /** Parallel feature groups in flight per track. */
  trackConcurrency: z.number().int().min(1).max(8).default(3),
  /** Max debate rounds per feature group before returning last. */
  maxRounds: z.number().int().min(1).max(6).default(3),
  /** Max Codex review↔fix rounds before returning last. */
  codexRounds: z.number().int().min(1).max(10).default(5),
  /** Which test tracks to run. */
  tracks: z.array(z.enum(["unit", "e2e"])).default(["unit", "e2e"]),
  /** Skip the features.ts discovery swarm (jump straight to hardening). */
  skipDiscovery: z.boolean().default(false),
});

const discoverySchema = z.object({
  additions: z
    .array(z.object({ group: z.string(), features: z.array(z.string()) }))
    .default([]),
  scannedAreas: z.array(z.string()).default([]),
  notes: z.string().default(""),
});

const mergeSchema = z.object({
  addedFeatures: z
    .array(z.object({ group: z.string(), features: z.array(z.string()) }))
    .default([]),
  groupsCreated: z.array(z.string()).default([]),
  totalAdded: z.number().int().default(0),
  summary: z.string(),
});

const codexReviewSchema = z.object({
  lgtm: z.boolean(),
  summary: z.string(),
  issues: z
    .array(
      z.object({
        severity: z.enum(["critical", "major", "minor", "nit"]),
        file: z.string().nullable().default(null),
        description: z.string(),
      }),
    )
    .default([]),
});

const codexFixSchema = z.object({
  summary: z.string(),
  filesChanged: z.array(z.string()).default([]),
  noop: z.boolean().default(false),
});

const { Workflow, smithers, outputs } = createSmithers({
  input: inputSchema,
  discovery: discoverySchema,
  merge: mergeSchema,
  tfHarden: tfHardenSchema,
  tfGap: tfGapSchema,
  tfArg: tfArgSchema,
  tfVerdict: tfVerdictSchema,
  codexReview: codexReviewSchema,
  codexFix: codexFixSchema,
});

// Opus for most tasks (Sonnet as failover); Codex leads the final review.
const opusPool = [providers.claudeOpus, providers.claudeSonnet];
const codexPool = [providers.codex, providers.codex1];
// Fable is the agent that actually adds the test coverage (user-directed);
// Sonnet as failover. providers.claude is claude-fable-5.
const fablePool = [providers.claude, providers.claudeSonnet];

// Audit scope shared with .smithers/specs/features.ts — the discovery swarm
// shards these areas across N agents looking for user-observable behavior that
// features.ts does not yet list.
const SCAN_AREAS = [
  "packages/engine packages/scheduler packages/driver",
  "packages/components packages/react-reconciler packages/graph",
  "packages/agents packages/accounts packages/usage packages/tool-context",
  "apps/cli",
  "packages/gateway packages/gateway-client packages/gateway-react packages/server",
  "packages/db packages/memory packages/time-travel packages/electric-proxy",
  "packages/openapi packages/scorers packages/sandbox packages/vcs",
  "packages/ui packages/ui-styleguide packages/gateway-ui packages/tui",
  "packages/integrations packages/telegram packages/cloudflare packages/agent-eliza",
  "packages/devtools packages/protocol packages/control-plane packages/pi-plugin",
  "apps/observability apps/bug-worker apps/telegram-summary packages/smithers",
  ".smithers/workflows .smithers/components .smithers/prompts scripts examples docs",
];

function shard<T>(items: T[], buckets: number): T[][] {
  const out: T[][] = Array.from({ length: buckets }, () => []);
  items.forEach((item, index) => out[index % buckets].push(item));
  return out.filter((bucket) => bucket.length > 0);
}

function discoveryPrompt(areas: string[], shardIndex: number): string {
  return [
    `# Feature discovery swarm — shard ${shardIndex + 1}`,
    "",
    "Read `.smithers/specs/features.ts` — it is a code-backed inventory of every user-observable Smithers feature, grouped by area.",
    "Scan these areas of the repo for real, shipped behavior that is MISSING from that inventory:",
    ...areas.map((a) => `- ${a}`),
    "",
    "A 'feature' here is a distinct, observable capability or behavior (a CLI flag, an engine behavior, a component prop contract, an error class, an event type, a lifecycle transition) — not an internal helper.",
    "For each real gap, propose an addition: the existing group name it belongs to (verbatim from features.ts), plus one or more SCREAMING_SNAKE_CASE feature tokens in the same style as the file.",
    "If a whole area has no matching group, propose a new group name.",
    "",
    "Do NOT edit any file. Only return structured `additions`. Be precise and conservative: no duplicates of items already in features.ts, no speculative/unshipped features.",
    "List the concrete files you scanned in scannedAreas.",
  ].join("\n");
}

function mergePrompt(
  discoveries: (z.infer<typeof discoverySchema> | undefined)[],
): string {
  const proposals = discoveries
    .map((d, shard) => ({
      shard,
      additions: d?.additions ?? [],
      notes: d?.notes ?? "",
    }))
    .filter((p) => p.additions.length > 0 || p.notes);
  const completed = discoveries.filter(Boolean).length;
  return [
    "# Merge discovered features into features.ts",
    "",
    `The discovery swarm returned proposals from ${discoveries.length} shards (${completed} completed; any failed shard is simply absent below).`,
    "Proposals (structured):",
    "```json",
    JSON.stringify(proposals, null, 2),
    "```",
    "Do this:",
    "1. Read `.smithers/specs/features.ts` and the proposals above.",
    "2. Drop any addition already present (exact or clear synonym of an existing token).",
    "3. Edit `.smithers/specs/features.ts` in place: append genuinely-missing tokens to their existing group's array, and create new groups where proposed. Keep the file's exact formatting and token style; keep it valid TypeScript.",
    "4. Do NOT remove or reorder existing entries.",
    "",
    "If there are no usable proposals (every shard failed), make no edits and return empty additions with totalAdded 0.",
    "Otherwise return the additions you actually wrote (addedFeatures), any new group names (groupsCreated), the total token count added, and a short summary.",
  ].join("\n");
}

function codexFixPrompt(
  review: z.infer<typeof codexReviewSchema> | undefined,
): string {
  if (!review || review.lgtm || review.issues.length === 0) {
    return [
      "# Address Codex review feedback",
      "",
      "There is no outstanding Codex review feedback yet (first pass, or the last review was LGTM).",
      "Do nothing to the code and return { noop: true } with a one-line summary.",
    ].join("\n");
  }
  return [
    "# Address Codex review feedback on the test-fortress changes",
    "",
    "The most recent Codex review did NOT approve. Fix every critical and major issue below (address minor/nit where cheap). Only touch the test-fortress test changes and the minimal product code needed.",
    "Re-run the affected suites and confirm green before returning. Set noop:false.",
    "",
    "## Review summary",
    review.summary,
    "",
    "## Issues",
    ...review.issues.map(
      (i) => `- [${i.severity}] ${i.file ?? "(no file)"}: ${i.description}`,
    ),
  ].join("\n");
}

function codexReviewPrompt(): string {
  return [
    "# Strict Codex review of all test-fortress changes",
    "",
    "Review ALL changes in this working tree versus `main` (run `git diff main...` / `git status` to see them). The changes should be new/expanded tests plus any minimal product fixes.",
    "Judge strictly:",
    "- Are the new tests meaningful (real assertions, real code paths) rather than coverage-padding?",
    "- Do e2e/integration tests use real backends (no mocks, no route fabrication)?",
    "- Do boundary/defensive/loop-limit/parameter-combination tests actually assert the boundary they claim?",
    "- Any product-code change correct, minimal, and covered by a regression test?",
    "- Does the touched suite pass? Run it.",
    "",
    "Set lgtm true ONLY if you would approve this as-is with no critical or major issues. Otherwise list concrete, actionable issues.",
  ].join("\n");
}

export default smithers((ctx) => {
  const input = ctx.input;
  const requested = new Set(input.groups ?? []);
  const limit = input.limit ?? 0;
  const discoveryAgents = input.discoveryAgents ?? 8;
  const trackConcurrency = input.trackConcurrency ?? 3;
  const maxRounds = input.maxRounds ?? 3;
  const codexRounds = input.codexRounds ?? 5;
  const tracks = input.tracks ?? ["unit", "e2e"];
  const skipDiscovery = input.skipDiscovery ?? false;

  const allGroups: FeatureWorkItem[] = Object.entries(
    FeatureGroups as Record<string, readonly string[]>,
  )
    .filter(([, features]) => Array.isArray(features) && features.length > 0)
    .map(([name, features]) => ({ name, features: [...features] }));

  const selected = allGroups.filter(
    (g) => requested.size === 0 || requested.has(g.name),
  );
  const groups = limit > 0 ? selected.slice(0, limit) : selected;

  const shards = shard(SCAN_AREAS, discoveryAgents);

  // Read whatever the discovery shards produced (failed continueOnFail shards
  // are simply absent). Sequence ordering runs merge after the swarm; reading
  // via ctx instead of needs/deps means a failed shard cannot dangle a
  // dependency into DEPENDENCY_DEADLOCK.
  const discoveries = shards.map((_, index) =>
    ctx.outputMaybe(outputs.discovery, { nodeId: `tf:discover:${index}` }) as
      | z.infer<typeof discoverySchema>
      | undefined,
  );

  const latestReview = ctx.outputMaybe(outputs.codexReview, {
    nodeId: "tf:codex:review",
  }) as z.infer<typeof codexReviewSchema> | undefined;
  const codexApproved = latestReview?.lgtm === true;

  return (
    <Workflow name="test-fortress">
      <Sequence>
        {/* Phase 1 — swarm the codebase for features missing from features.ts */}
        {!skipDiscovery ? (
          <Sequence>
            <Parallel maxConcurrency={discoveryAgents}>
              {shards.map((areas, index) => (
                <Task
                  key={`discover-${index}`}
                  id={`tf:discover:${index}`}
                  output={outputs.discovery}
                  agent={opusPool}
                  continueOnFail
                  timeoutMs={30 * 60_000}
                  heartbeatTimeoutMs={10 * 60_000}
                >
                  {discoveryPrompt(areas, index)}
                </Task>
              ))}
            </Parallel>
            <Task
              id="tf:discover:merge"
              output={outputs.merge}
              agent={opusPool}
              continueOnFail
              timeoutMs={30 * 60_000}
              heartbeatTimeoutMs={10 * 60_000}
            >
              {mergePrompt(discoveries)}
            </Task>
          </Sequence>
        ) : null}

        {/* Phase 2 — two parallel tracks: unit vs e2e/integration */}
        <Parallel>
          {tracks.includes("unit") ? (
            <TestFortressTrack
              ctx={ctx}
              outputs={outputs}
              track="unit"
              groups={groups}
              implementAgent={fablePool}
              reviewAgent={opusPool}
              debateAgent={opusPool}
              judgeAgent={opusPool}
              maxRounds={maxRounds}
              maxConcurrency={trackConcurrency}
            />
          ) : null}
          {tracks.includes("e2e") ? (
            <TestFortressTrack
              ctx={ctx}
              outputs={outputs}
              track="e2e"
              groups={groups}
              implementAgent={fablePool}
              reviewAgent={opusPool}
              debateAgent={opusPool}
              judgeAgent={opusPool}
              maxRounds={maxRounds}
              maxConcurrency={trackConcurrency}
            />
          ) : null}
        </Parallel>

        {/* Phase 3 — Codex reviews every change in a loop until LGTM */}
        <Loop
          id="tf:codex:loop"
          until={codexApproved}
          maxIterations={codexRounds}
          onMaxReached="return-last"
        >
          <Sequence>
            <Task
              id="tf:codex:fix"
              output={outputs.codexFix}
              agent={opusPool}
              continueOnFail
              timeoutMs={60 * 60_000}
              heartbeatTimeoutMs={10 * 60_000}
            >
              {codexFixPrompt(latestReview)}
            </Task>
            <Task
              id="tf:codex:review"
              output={outputs.codexReview}
              agent={codexPool}
              continueOnFail
              timeoutMs={40 * 60_000}
              heartbeatTimeoutMs={10 * 60_000}
            >
              {codexReviewPrompt()}
            </Task>
          </Sequence>
        </Loop>
      </Sequence>
    </Workflow>
  );
});
