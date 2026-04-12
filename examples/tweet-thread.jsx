/**
 * <TweetThread> — Scan all Smithers example workflows, rank them, draft a
 * countdown tweet thread, and (optionally) post it to X/Twitter via the API.
 *
 * Pattern: Fan-out scan → Rank → Draft → Post with Timer delays.
 * Use cases: automated social media content from your own repo, release
 * announcements, "best-of" showcases.
 *
 * Set these env vars to enable auto-posting:
 *   X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET
 *
 * Without them the workflow still produces the full thread as structured output
 * so you can copy-paste it manually.
 */
import { Sequence, Parallel, Timer } from "smithers-orchestrator";
import { createExampleSmithers, asArray } from "./_example-kit.js";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, bash } from "smithers-orchestrator/tools";
import { z } from "zod";
import SummarizePrompt from "./prompts/tweet-thread/summarize.mdx";
import RankPrompt from "./prompts/tweet-thread/rank.mdx";
import DraftPrompt from "./prompts/tweet-thread/draft.mdx";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const fileScanSchema = z.object({
  files: z.array(
    z.object({
      name: z.string(),
      source: z.enum(["examples", ".smithers/workflows"]),
      filePath: z.string(),
    })
  ),
});

const summarySchema = z.object({
  name: z.string(),
  source: z.enum(["examples", ".smithers/workflows"]),
  filePath: z.string(),
  summary: z.string(),
  pattern: z.string(),
  useCase: z.string(),
});

const rankedItemSchema = z.object({
  rank: z.number(),
  name: z.string(),
  source: z.enum(["examples", ".smithers/workflows"]),
  oneLiner: z.string(),
  whyThisRank: z.string(),
});

const rankingSchema = z.object({
  honorableMention: rankedItemSchema,
  ranked: z.array(rankedItemSchema),
});

const threadSchema = z.object({
  tweets: z.array(
    z.object({
      index: z.number(),
      text: z.string(),
      role: z.enum(["opening", "honorable-mention", "countdown", "closing"]),
    })
  ),
  totalTweets: z.number(),
});

const tweetPostSchema = z.object({
  tweetId: z.string(),
  posted: z.boolean(),
  error: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const { Workflow, Task, smithers, outputs } = createExampleSmithers({
  fileScan: fileScanSchema,
  summary: summarySchema,
  ranking: rankingSchema,
  thread: threadSchema,
  tweetPost: tweetPostSchema,
});

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

const fileScanAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash },
  instructions: `You list workflow files in a repo. Run shell commands to find
them, then return structured JSON. Exclude helper/utility files like
_example-kit.js — only return actual workflow definitions.`,
});

const scanner = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read },
  instructions: `You read Smithers workflow source files and produce concise,
punchy summaries. Focus on what makes each workflow interesting and what
real-world problem it solves. Be concrete, not abstract.`,
});

const ranker = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  instructions: `You are a developer advocate ranking workflow examples for a
social media countdown. You value practical utility, wow factor, and how well
each example teaches an orchestration concept.`,
});

const copywriter = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  instructions: `You are a sharp technical copywriter. You write tweets that
sound like a senior engineer who's genuinely excited — not a marketing person.
Every tweet must be under 280 characters. You're funny when appropriate and
never cringe. No hashtag spam.`,
});

const poster = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash },
  instructions: `You post a single tweet to X/Twitter using the twitter-api-v2
npm package. Write and execute a short Node.js script that:
1. Creates a TwitterApi client from env vars
2. Posts the tweet (as a reply if a reply-to ID is provided)
3. Returns the new tweet ID

If X_API_KEY env var is not set, return posted: false and tweetId: "" with an
error explaining what credentials are needed.

Install the package first if needed: npm install --no-save twitter-api-v2`,
});

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

export default smithers((ctx) => {
  const scanResult = ctx.outputMaybe("fileScan", { nodeId: "scan-files" });
  const files = scanResult?.files ?? [];
  const summaries = ctx.outputs.summary ?? [];
  const ranking = ctx.outputMaybe("ranking", { nodeId: "rank" });
  const thread = ctx.outputMaybe("thread", { nodeId: "draft" });

  return (
    <Workflow name="tweet-thread">
      <Sequence>
        {/* Phase 1: Discover all workflow files */}
        <Task id="scan-files" output={outputs.fileScan} agent={fileScanAgent}>
          List all Smithers workflow files in these two directories:
          1. examples/*.jsx (exclude _example-kit.js)
          2. .smithers/workflows/*.tsx

          Return a JSON object with a "files" array. Each entry needs "name"
          (filename without extension), "source" ("examples" or
          ".smithers/workflows"), and "filePath" (relative path from repo root).
        </Task>

        {/* Phase 2: Read and summarize each workflow in parallel */}
        {files.length > 0 && (
          <Parallel maxConcurrency={10}>
            {files.map((file) => (
              <Task
                key={file.name}
                id={`summarize-${file.name}`}
                output={outputs.summary}
                agent={scanner}
                continueOnFail
                timeoutMs={60_000}
              >
                <SummarizePrompt filePath={file.filePath} />
              </Task>
            ))}
          </Parallel>
        )}

        {/* Phase 3: Rank all workflows by usefulness / wow factor */}
        {summaries.length > 0 && (
          <Task id="rank" output={outputs.ranking} agent={ranker}>
            <RankPrompt totalCount={summaries.length} summaries={summaries} />
          </Task>
        )}

        {/* Phase 4: Draft the tweet thread */}
        {ranking && (
          <Task id="draft" output={outputs.thread} agent={copywriter}>
            <DraftPrompt
              totalRanked={ranking.ranked.length}
              ranked={ranking.ranked}
              honorableMention={ranking.honorableMention}
            />
          </Task>
        )}

        {/* Phase 5: Post each tweet with a 30s Timer between them */}
        {thread && thread.tweets.map((tweet, i) => {
          const prev = i > 0
            ? ctx.outputMaybe("tweetPost", { nodeId: `post-${i - 1}` })
            : null;
          return (
            <Sequence key={tweet.index}>
              {i > 0 && <Timer id={`tweet-delay-${i}`} duration="30s" />}
              <Task id={`post-${i}`} output={outputs.tweetPost} agent={poster}>
                Post this tweet to X/Twitter:

                "{tweet.text}"

                {prev
                  ? `This is a reply to tweet ID: ${prev.tweetId}`
                  : "This is the first tweet in the thread (no reply-to)."}

                Use env vars X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN,
                X_ACCESS_SECRET for OAuth 1.0a auth.
              </Task>
            </Sequence>
          );
        })}
      </Sequence>
    </Workflow>
  );
});
