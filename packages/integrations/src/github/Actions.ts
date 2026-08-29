/**
 * The durable GitHub actions.
 *
 * {@link GitHubClient} is the host layer: it knows rate limits, pagination,
 * and token hygiene, and it is an ordinary Effect service. An `Action` is what
 * makes one of its calls a step of a durable flow, so a plan can name it, the
 * journal can record its result, and a restart replays it instead of posting
 * a second comment.
 *
 * Each action is declared here and implemented by {@link layer}. A flow body
 * calls `CommentOnIssue.call(...)`, which records a plan node and nothing
 * else; the layer is what a composition provides to make that node runnable.
 *
 * @since 1.0.0
 */
import { Action, type FlowRuntime } from "@smthrs/flow"
import { Effect, type Layer, Schema } from "effect"
import { fromIntegrationError, IntegrationFailure } from "../core/ActionFailure.ts"
import { GitHubClient } from "./GitHubClient.ts"

/**
 * What {@link CommentOnIssue} needs.
 *
 * `issueNumber` is GitHub's issue or pull-request number. GitHub numbers both
 * in one sequence, so the same action comments on either.
 *
 * @category schemas
 * @since 1.0.0
 */
export const CommentOnIssuePayload = Schema.Struct({
  owner: Schema.String,
  repo: Schema.String,
  issueNumber: Schema.Number,
  body: Schema.String
})

/**
 * The comment GitHub created.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Comment = Schema.Struct({
  id: Schema.Number,
  url: Schema.String
})

/**
 * Posts a comment on an issue or pull request.
 *
 * The tier is `irreversible`: the comment is visible the moment GitHub
 * accepts it, and deleting it afterwards is a different call with a different
 * outcome, so the engine must never retry this step on its own.
 *
 * @category actions
 * @since 1.0.0
 */
export const CommentOnIssue = Action.make("integrations/github/comment-on-issue", {
  payload: CommentOnIssuePayload,
  success: Comment,
  error: IntegrationFailure,
  tier: "irreversible"
})

/**
 * Implements {@link CommentOnIssue} over the client in context.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerCommentOnIssue: Layer.Layer<
  Action.Requirement<"integrations/github/comment-on-issue">,
  never,
  GitHubClient | FlowRuntime.FlowRuntime
> = CommentOnIssue.toLayer((payload) =>
  Effect.gen(function*() {
    const client = yield* GitHubClient
    return yield* client.request(
      "POST",
      `/repos/${payload.owner}/${payload.repo}/issues/${payload.issueNumber}/comments`,
      { body: payload.body },
      { schema: Comment }
    )
  }).pipe(Effect.mapError(fromIntegrationError))
)

/**
 * Every GitHub action's implementation, in one layer.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer: Layer.Layer<
  Action.Requirement<"integrations/github/comment-on-issue">,
  never,
  GitHubClient | FlowRuntime.FlowRuntime
> = layerCommentOnIssue
