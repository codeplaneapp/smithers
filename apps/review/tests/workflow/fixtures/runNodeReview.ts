/**
 * Runs one review under the durable Node composition, against a local provider.
 *
 * This is a Node entry point on purpose. `layerNode` builds the host's undici
 * HTTP client, which does not construct under Bun, so the composition the
 * shipped CLI actually runs can only be exercised from Node. The suite spawns
 * this file and reads the one JSON line it prints.
 *
 * Argv: the repository to review, then the database file to run it in.
 */
import { createServer } from "node:http";
import { join } from "node:path";
import { Effect } from "effect";
import { Review } from "../../../src/workflow/reviewFlow.ts";
import { layerNode } from "../../../src/workflow/reviewLayerNode.ts";
import { reviewSeatResolver } from "../../../src/workflow/reviewSeatResolver.ts";
import { resolveReviewSeats } from "../../../src/workflow/reviewSeats.ts";

const reviewAnswer = {
  status: "success",
  message: "",
  summary: null,
  comments: [
    {
      path: "src/file0.ts",
      content: "The new binding shadows the old one.",
      severity: "major",
      category: "correctness",
      confidence: "confirmed",
      startLine: 2,
      endLine: 2,
      existingCode: "",
      suggestionCode: "",
      thinking: "",
    },
  ],
  warnings: [],
};

/** One Anthropic SSE response carrying a fenced cell block with `answer`. */
function sseCell(answer: unknown): string {
  const cell = "```cell\n" + `ctx.done(${JSON.stringify(answer)})` + "\n```";
  const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  return [
    frame("message_start", {
      type: "message_start",
      message: {
        id: "msg_fixture",
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-sonnet-4-5",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 0 },
      },
    }),
    frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: cell } }),
    frame("content_block_stop", { type: "content_block_stop", index: 0 }),
    frame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 3 },
    }),
    frame("message_stop", { type: "message_stop" }),
  ].join("");
}

const repo = process.argv[2]!;
const filename = process.argv[3]!;

let requests = 0;
const provider = createServer((request, response) => {
  requests += 1;
  request.resume();
  request.on("end", () => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(sseCell(reviewAnswer));
  });
});

await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
const address = provider.address();
const port = typeof address === "object" && address !== null ? address.port : 0;

const environment = {
  ANTHROPIC_API_KEY: "fixture-key",
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
  SMITHERS_REVIEW_SEAT: "anthropic:claude-sonnet-4-5",
};

const report = (value: Record<string, unknown>) => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

try {
  const result = await Effect.runPromise(
    Review.execute(
      {
        repo,
        narrate: false,
        quiz: "off",
        verify: false,
        out: join(repo, "walkthrough.html"),
      } as Parameters<typeof Review.execute>[0],
      { executionId: `review-layer-node-${Date.now()}` },
    ).pipe(
      Effect.provide(
        layerNode({
          filename,
          seats: reviewSeatResolver(resolveReviewSeats(environment), environment),
          environment,
        }),
      ),
      Effect.scoped,
    ),
  );
  report({
    ok: true,
    requests,
    status: result.review.status,
    paths: result.review.comments.map((comment) => comment.path),
    warnings: result.review.warnings.map((warning) => warning.type),
  });
} catch (error) {
  report({ ok: false, requests, error: (error as Error)?.message ?? String(error) });
} finally {
  provider.close();
}

process.exit(0);
