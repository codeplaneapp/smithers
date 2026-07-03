import { LinearConfig as LinearConfig$1 } from './LinearConfig.js';
import { CreateIssueInput as CreateIssueInput$1, LinearClientService as LinearClientService$1, LinearCommentResult as LinearCommentResult$1, LinearIssueResult as LinearIssueResult$1, LinearPriority as LinearPriority$1, LinearTeamRef as LinearTeamRef$1 } from './LinearClientTypes.js';
import { Context, Layer } from 'effect';
import '@smithers-orchestrator/errors/SmithersError';

/**
 * Layer providing {@link LinearClient} from config (explicit >
 * `configureLinear` > env).
 * @param {LinearConfig} [config]
 */
declare function LinearClientLive(config?: LinearConfig): Layer.Layer<LinearClientService$1, never, never>;
/**
 * Normalize a priority name or number to Linear's 0–4 scale.
 * @param {LinearPriority | undefined} priority
 * @returns {number | undefined}
 */
declare function normalizeLinearPriority(priority: LinearPriority | undefined): number | undefined;
/**
 * Build a plain-fetch Linear GraphQL client. Behaviors ported from
 * eliza's plugin-linear (via @linear/sdk) reimplemented over raw GraphQL:
 * team lookup by key, workflow-state / label name resolution (cached per
 * client), issueCreate/issueUpdate/commentCreate, issue lookup by
 * `ENG-123` identifier, 429/5xx retry honoring rate-limit headers.
 *
 * The API key is only used for the `Authorization` header — never logged
 * and never included in error details.
 *
 * @param {LinearConfig} [config]
 * @returns {LinearClientService}
 */
declare function makeLinearClient(config?: LinearConfig): LinearClientService;
/** Context tag for the Linear GraphQL client service. */
declare const LinearClient: Context.Tag<LinearClientService, LinearClientService>;
type CreateIssueInput = CreateIssueInput$1;
type LinearClientService = LinearClientService$1;
type LinearCommentResult = LinearCommentResult$1;
type LinearIssueResult = LinearIssueResult$1;
type LinearPriority = LinearPriority$1;
type LinearTeamRef = LinearTeamRef$1;
type LinearConfig = LinearConfig$1;

export { type CreateIssueInput, LinearClient, LinearClientLive, type LinearClientService, type LinearCommentResult, type LinearConfig, type LinearIssueResult, type LinearPriority, type LinearTeamRef, makeLinearClient, normalizeLinearPriority };
