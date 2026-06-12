#!/usr/bin/env bun
import { execFileSync, spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { loadOutputs } from "@smithers-orchestrator/db/snapshot";
import { runWorkflow } from "@smithers-orchestrator/engine";
import { Effect } from "effect";
import { buildPullRequestReview } from "../github/buildPullRequestReview";
import { listPullRequestFiles } from "../github/listPullRequestFiles";
import { postPullRequestReview } from "../github/postPullRequestReview";
import { resolvePullRequest, type PullRequestTarget } from "../github/resolvePullRequest";
import { storySchema } from "../walkthrough/storySchema";
import { createReviewAgents } from "../workflow/createReviewAgents";
import { createReviewWorkflow } from "../workflow/createReviewWorkflow";
import { parseReviewArgs, type ReviewArgs } from "./parseReviewArgs";
import { publishWalkthrough } from "./publishWalkthrough";

function refExists(repoDir: string, ref: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", ref], { cwd: repoDir, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

type Finding = Parameters<typeof buildPullRequestReview>[0]["findings"][number];

// Output rows store array columns as JSON strings.
function parseFindings(value: unknown): Finding[] {
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as Finding[]) : [];
  } catch {
    return [];
  }
}

const USAGE = `smithers review — code review + story-form HTML walkthrough

Usage: smithers-review [repo] [options]

  --from <ref> --to <ref>   review a ref range (merge-base diff)
  --commit <sha>            review a single commit
                            (default: workspace changes, tracked + untracked)
  --background <text>       requirement background for review + narrator
  --title <text>            walkthrough title (default: narrator headline)
  --out <file>              output HTML path (default: <repo>/.smithers-review/walkthrough.html)
  --db <file>               smithers db path (default: <repo>/.smithers-review/review.db)
  --no-review               skip review agents; walkthrough only
  --no-narrate              skip the narrator agent; deterministic story order
  --concurrency <n>         parallel file reviews (default 8)
  --timeout <min>           per-agent-task timeout in minutes (default 10)
  --split                   side-by-side diffs instead of unified
  --publish                 upload to the share service and print the share URL
  --pr <number|url>         review a GitHub PR and post the review onto it (via gh)
  --open                    open the walkthrough in the default browser
  -h, --help                show this help`;

async function main() {
  let args: ReviewArgs;
  try {
    args = parseReviewArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`smithers-review: ${(error as Error).message}\n`);
    console.error(USAGE);
    process.exit(1);
    return;
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }

  const repoDir = resolve(args.repo);
  const dbPath = args.db ? resolve(args.db) : join(repoDir, ".smithers-review", "review.db");

  let pr: PullRequestTarget | null = null;
  if (args.pr) {
    pr = await resolvePullRequest(repoDir, args.pr);
    if (!refExists(repoDir, pr.headSha)) {
      // The PR head may not exist locally (reviewing someone else's PR);
      // fetch it so the review diff can resolve.
      execFileSync("git", ["fetch", "origin", pr.headSha], { cwd: repoDir, stdio: "pipe" });
    }
    if (!args.from && !args.to && !args.commit) {
      // Prefer the remote-tracking base: the local base branch may be stale
      // and would drag unrelated commits into the review diff.
      args.from = refExists(repoDir, `origin/${pr.baseRefName}`) ? `origin/${pr.baseRefName}` : pr.baseRefName;
      args.to = pr.headSha;
      console.error(`[smithers-review] PR #${pr.number} (${pr.baseRefName}…${pr.headRefName}) → ${args.from}..${args.to}`);
    }
  }

  const agents = args.review || args.narrate ? createReviewAgents(repoDir) : { review: [], narrate: [] };
  const { workflow, db, tables } = createReviewWorkflow({
    dbPath,
    reviewAgents: args.review ? agents.review : [],
    narratorAgents: args.narrate ? agents.narrate : [],
  });

  const runId = `review-${Date.now()}`;
  const input = {
    repo: repoDir,
    from: args.from,
    to: args.to,
    commit: args.commit,
    background: args.background,
    rule: "",
    concurrency: args.concurrency,
    timeout: args.timeout,
    runReview: args.review,
    out: args.out,
    narrate: args.narrate,
    title: args.title,
    split: args.split,
  };

  console.error(
    `[smithers-review] run ${runId} on ${repoDir} (review ${args.review ? "on" : "off"}, narration ${args.narrate ? "on" : "off"})`,
  );
  const result = (await Effect.runPromise(
    runWorkflow(workflow as never, { input, runId, allowNetwork: true }) as never,
  )) as { status: string };

  const rows = (await loadOutputs(db as never, tables as never, runId)) as Record<
    string,
    Record<string, unknown>[]
  >;
  const walkthrough = rows.walkthrough?.at(-1);
  const review = rows.review?.at(-1);

  if (!walkthrough) {
    console.error(`[smithers-review] run ended with status "${result.status}" but produced no walkthrough.`);
    process.exit(1);
    return;
  }

  if (review?.message) console.log(`Review: ${String(review.message)}`);
  console.log(String(walkthrough.message ?? `Walkthrough written to ${String(walkthrough.path)}`));

  let publishFailed = false;
  let shareUrl = "";
  if (args.publish) {
    try {
      shareUrl = await publishWalkthrough(String(walkthrough.path));
      console.log(`Published: ${shareUrl}`);
    } catch (error) {
      publishFailed = true;
      console.error(`smithers-review: ${(error as Error).message}`);
    }
  }

  let prFailed = false;
  if (pr) {
    try {
      const story = storySchema.parse(JSON.parse(String(walkthrough.story || "{}")));
      const findings = parseFindings(review?.comments);
      const prPaths = await listPullRequestFiles(repoDir, pr);
      const payload = buildPullRequestReview({
        story,
        findings,
        prPaths,
        headSha: pr.headSha,
        walkthroughUrl: shareUrl || undefined,
      });
      const posted = await postPullRequestReview(repoDir, pr, payload);
      console.log(`PR review posted (${posted.inline} inline comment(s)): ${posted.url}`);
    } catch (error) {
      prFailed = true;
      console.error(`smithers-review: PR review failed: ${(error as Error).message}`);
    }
  }

  if (args.open) {
    const opener = process.platform === "darwin" ? "open" : "xdg-open";
    spawn(opener, [String(walkthrough.path)], { stdio: "ignore", detached: true }).unref();
  }

  const failed = result.status === "failed" || result.status === "cancelled" || publishFailed || prFailed;
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(`smithers-review: ${(error as Error)?.message ?? String(error)}`);
  process.exit(1);
});
