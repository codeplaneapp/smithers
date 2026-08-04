// smithers-display-name: Upgrade dependents to smthrs
// smithers-source: reusable — discovers every known open-source repo that still
// depends on the old npm name (OLD_NAME below; awesome-smithers list +
// GitHub code search + any extraRepos input), then in parallel lanes:
//   1. luna: fork-ready upgrade — rename to smthrs, bump to latest, read the
//      changelogs between the repo's pinned version and latest, apply BREAKING
//      changes in the same branch, and record improvement ideas (new features /
//      new idioms) for a separate PR.
//   2. sol: review the upgrade diff.
//   3. fable: final pre-PR review, then open the upgrade PR from a smithersai
//      org fork (reusing an existing fork).
//   4. fable (only when improvement ideas exist): implement improvements on a
//      separate branch, final-review, open a second PR and file an upstream
//      issue describing them.
/** @jsxImportSource smthrs */
import { ClaudeCodeAgent, UI, createSmithers } from "smthrs";
import { z } from "zod/v4";
import { codexFirst } from "../lib/codexAccounts";
import DiscoverPrompt from "../prompts/upgrade-dependents-discover.mdx";
import ImprovePrompt from "../prompts/upgrade-dependents-improve.mdx";
import PrPrompt from "../prompts/upgrade-dependents-pr.mdx";
import ReviewPrompt from "../prompts/upgrade-dependents-review.mdx";
import UpgradePrompt from "../prompts/upgrade-dependents-upgrade.mdx";

const OLD_NAME = "smithers" + "-orchestrator"; // split so this workflow never matches its own audit greps
const NEW_NAME = "smthrs";
const FORK_ORG = "smithersai";
const BRANCH = "upgrade-smthrs";
const IMPROVE_BRANCH = "improve-smthrs";
const CHANGELOG_DIR = "/Users/williamcory/smithers/docs/changelogs"; // fallback: raw.githubusercontent.com/smithersai/smithers/main/docs/changelogs/<v>.mdx

const names = { oldName: OLD_NAME, newName: NEW_NAME, forkOrg: FORK_ORG, branch: BRANCH };

const discoverSchema = z.object({
  repos: z.array(z.string()).default([]),
  sources: z.string().default(""),
  notes: z.string().default(""),
});

const upgradeSchema = z.object({
  repo: z.string(),
  status: z.enum(["upgraded", "no-hits", "blocked"]).default("upgraded"),
  branch: z.string().default(""),
  clonePath: z.string().default(""),
  filesChanged: z.number().int().default(0),
  oldVersion: z.string().default(""),
  newVersion: z.string().default(""),
  breakingApplied: z.string().default(""),
  improvementIdeas: z.array(z.string()).default([]),
  grepClean: z.boolean().default(false),
  grepOutput: z.string().default(""),
  notes: z.string().default(""),
});

const reviewSchema = z.object({
  repo: z.string(),
  approved: z.boolean(),
  feedback: z.string().default(""),
  issues: z
    .array(
      z.object({
        severity: z.enum(["critical", "major", "minor", "nit"]).default("nit"),
        file: z.string().default(""),
        description: z.string().default(""),
      }),
    )
    .default([]),
});

const prSchema = z.object({
  repo: z.string(),
  prUrl: z.string().nullable().default(null),
  forkRepo: z.string().default(""),
  skipped: z.boolean().default(false),
  summary: z.string().default(""),
});

const improveSchema = z.object({
  repo: z.string(),
  prUrl: z.string().nullable().default(null),
  issueUrl: z.string().nullable().default(null),
  implemented: z.array(z.string()).default([]),
  skipped: z.boolean().default(false),
  summary: z.string().default(""),
});

const inputSchema = z.object({
  extraRepos: z.array(z.string()).default([]),
  excludeRepos: z.array(z.string()).default(["smithersai/smithers", "smithersai/awesome-smithers"]),
  maxConcurrency: z.number().int().min(1).max(8).default(4),
});

const { Workflow, Task, Sequence, Parallel, smithers, outputs } = createSmithers({
  input: inputSchema,
  discover: discoverSchema,
  upgrade: upgradeSchema,
  review: reviewSchema,
  pr: prSchema,
  improve: improveSchema,
});

const luna = codexFirst(
  {
    model: "gpt-5.6-luna",
    config: { model_reasoning_effort: "medium" },
    sandbox: "danger-full-access",
    dangerouslyBypassApprovalsAndSandbox: true,
    skipGitRepoCheck: true,
  },
  [new ClaudeCodeAgent({ model: "claude-sonnet-5" })],
);

const sol = codexFirst(
  {
    model: "gpt-5.6-sol",
    sandbox: "danger-full-access",
    dangerouslyBypassApprovalsAndSandbox: true,
    skipGitRepoCheck: true,
  },
  [new ClaudeCodeAgent({ model: "claude-opus-5" })],
);

const fable = new ClaudeCodeAgent({ model: "claude-fable-5" });

const DISCOVER_TIMEOUT_MS = 20 * 60_000;
const UPGRADE_TIMEOUT_MS = 30 * 60_000;
const REVIEW_TIMEOUT_MS = 20 * 60_000;
const PR_TIMEOUT_MS = 20 * 60_000;
const IMPROVE_TIMEOUT_MS = 45 * 60_000;

const laneId = (repo: string) => repo.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase();

export default smithers((ctx) => {
  const discovered = ctx.outputMaybe(outputs.discover, { nodeId: "discover" });
  const exclude = new Set(ctx.input.excludeRepos ?? []);
  const repos = discovered
    ? [...new Set([...(discovered.repos ?? []), ...(ctx.input.extraRepos ?? [])])].filter((r) => !exclude.has(r)).sort()
    : [];
  return (
    <Workflow name="upgrade-dependents">
      <UI entry="../ui/upgrade-dependents.tsx" title={"Upgrade dependents to smthrs"} />
      <Task id="discover" output={outputs.discover} agent={luna} retries={2} timeoutMs={DISCOVER_TIMEOUT_MS}>
        <DiscoverPrompt {...names} extraRepos={ctx.input.extraRepos} excludeRepos={ctx.input.excludeRepos} />
      </Task>
      {discovered ? (
        <Parallel maxConcurrency={ctx.input.maxConcurrency}>
          {repos.map((repo) => {
            const id = laneId(repo);
            const upgrade = ctx.outputMaybe(outputs.upgrade, { nodeId: `upgrade-${id}` });
            const review = ctx.outputMaybe(outputs.review, { nodeId: `review-${id}` });
            const pr = ctx.outputMaybe(outputs.pr, { nodeId: `pr-${id}` });
            return (
              <Sequence key={id}>
                <Task
                  id={`upgrade-${id}`}
                  output={outputs.upgrade}
                  agent={luna}
                  retries={2}
                  timeoutMs={UPGRADE_TIMEOUT_MS}
                >
                  <UpgradePrompt {...names} repo={repo} laneId={id} changelogDir={CHANGELOG_DIR} />
                </Task>
                {upgrade && upgrade.status === "upgraded" && upgrade.grepClean ? (
                  <Task
                    id={`review-${id}`}
                    output={outputs.review}
                    agent={sol}
                    retries={2}
                    timeoutMs={REVIEW_TIMEOUT_MS}
                  >
                    <ReviewPrompt {...names} repo={repo} clonePath={upgrade.clonePath} />
                  </Task>
                ) : null}
                {upgrade && review?.approved ? (
                  <Task id={`pr-${id}`} output={outputs.pr} agent={fable} retries={2} timeoutMs={PR_TIMEOUT_MS}>
                    <PrPrompt
                      {...names}
                      repo={repo}
                      clonePath={upgrade.clonePath}
                      upgrade={JSON.stringify(upgrade)}
                      review={review.feedback || "approved"}
                    />
                  </Task>
                ) : null}
                {upgrade && pr?.prUrl && upgrade.improvementIdeas.length > 0 ? (
                  <Task
                    id={`improve-${id}`}
                    output={outputs.improve}
                    agent={fable}
                    retries={2}
                    timeoutMs={IMPROVE_TIMEOUT_MS}
                  >
                    <ImprovePrompt
                      {...names}
                      improveBranch={IMPROVE_BRANCH}
                      repo={repo}
                      clonePath={upgrade.clonePath}
                      ideas={upgrade.improvementIdeas}
                      upgradePrUrl={pr.prUrl}
                    />
                  </Task>
                ) : null}
              </Sequence>
            );
          })}
        </Parallel>
      ) : null}
    </Workflow>
  );
});
