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
import {
  Sequence,
  Parallel,
  Timer,
  ClaudeCodeAgent,
} from "smithers-orchestrator";
import { createExampleSmithers } from "./_example-kit.js";
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
    }),
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
    }),
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

const scanner = new ClaudeCodeAgent({
  model: "claude-sonnet-4-20250514",
  systemPrompt: `You read Smithers workflow source files and produce concise,
punchy summaries. Focus on what makes each workflow interesting and what
real-world problem it solves. Be concrete, not abstract.`,
});

const ranker = new ClaudeCodeAgent({
  model: "claude-sonnet-4-20250514",
  systemPrompt: `You are a developer advocate ranking workflow examples for a
social media countdown. You value practical utility, wow factor, and how well
each example teaches an orchestration concept.`,
});

const copywriter = new ClaudeCodeAgent({
  model: "claude-sonnet-4-20250514",
  systemPrompt: `You are a sharp technical copywriter. You write tweets that
sound like a senior engineer who's genuinely excited — not a marketing person.
Every tweet must be under 280 characters. You're funny when appropriate and
never cringe. No hashtag spam.`,
});

/** Post a single tweet. Returns { tweetId, posted, error? }. */
async function postTweet(text, replyToId) {
  const apiKey = process.env.X_API_KEY;
  const apiSecret = process.env.X_API_SECRET;
  const accessToken = process.env.X_ACCESS_TOKEN;
  const accessSecret = process.env.X_ACCESS_SECRET;
  if (!apiKey || !apiSecret || !accessToken || !accessSecret) {
    return {
      tweetId: "",
      posted: false,
      error: "Missing X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, or X_ACCESS_SECRET env vars.",
    };
  }
  const { TwitterApi } = await import("twitter-api-v2");
  const client = new TwitterApi({ appKey: apiKey, appSecret: apiSecret, accessToken, accessSecret });
  const params = replyToId ? { text, reply: { in_reply_to_tweet_id: replyToId } } : { text };
  const { data } = await client.v2.tweet(params);
  return { tweetId: data.id, posted: true };
}

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
        <Task id="scan-files" output={outputs.fileScan}>
          {async () => {
            const examplesGlob = new Bun.Glob("examples/*.jsx");
            const workflowsGlob = new Bun.Glob(".smithers/workflows/*.tsx");
            const files = [];
            for await (const path of examplesGlob.scan(".")) {
              const name = path
                .split("/")
                .pop()
                .replace(/\.jsx$/, "");
              if (name.startsWith("_")) continue;
              files.push({ name, source: "examples", filePath: path });
            }
            for await (const path of workflowsGlob.scan(".")) {
              const name = path
                .split("/")
                .pop()
                .replace(/\.tsx$/, "");
              files.push({
                name,
                source: ".smithers/workflows",
                filePath: path,
              });
            }
            return { files };
          }}
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
                timeoutMs={300_000}

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
        {thread &&
          thread.tweets.map((tweet, i) => {
            const prev =
              i > 0
                ? ctx.outputMaybe("tweetPost", { nodeId: `post-${i - 1}` })
                : null;
            return (
              <Sequence key={tweet.index}>
                {i > 0 && <Timer id={`tweet-delay-${i}`} duration="30s" />}
                <Task id={`post-${i}`} output={outputs.tweetPost}>
                  {() => postTweet(tweet.text, prev?.tweetId)}
                </Task>
              </Sequence>
            );
          })}
      </Sequence>
    </Workflow>
  );
});
