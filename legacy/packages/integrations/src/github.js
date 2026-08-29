// @smithers-type-exports-begin
/** @typedef {import("./github/ListenerRegistryTypes.ts").GitHubListener} GitHubListener */
/** @typedef {import("./github/ListenerRegistryTypes.ts").GitHubListenerEvent} GitHubListenerEvent */
/** @typedef {import("./github/ListenerRegistryTypes.ts").GitHubListenerOwnership} GitHubListenerOwnership */
/** @typedef {import("./github/ListenerRegistryTypes.ts").GitHubRemoteHook} GitHubRemoteHook */
/** @typedef {import("./github/ListenerRegistryTypes.ts").ListenerOwnershipState} ListenerOwnershipState */
/** @typedef {import("./github/ListenerRegistryTypes.ts").ListenerPlanAction} ListenerPlanAction */
/** @typedef {import("./github/ListenerRegistryTypes.ts").ListenerReconcilePlan} ListenerReconcilePlan */
/** @typedef {import("./github/ListenerRegistryTypes.ts").ListenerRegistry} ListenerRegistry */
/** @typedef {import("./github/ListenerRegistryTypes.ts").ReconcileGitHubListenersOptions} ReconcileGitHubListenersOptions */
// @smithers-type-exports-end

// @smthrs/integrations/github — GitHub integration surface.
//
// Inbound: `makeGitHubWebhookSource` (X-Hub-Signature-256 verified, per-action
// signal fan-out) + declarative listeners (`OnWebhook`, `OnPullRequest`,
// `OnIssueOpened`, `OnIssueComment`, `OnPush`).
// Outbound: deterministic compute-Task components (`Comment`, `CreateIssue`,
// `CreatePullRequest`, `AddLabels`, `SetCommitStatus`) over the Effect-native
// `GitHubClient`. Configure credentials with `configureGitHub` (or env).
export { configureGitHub, DEFAULT_GITHUB_API_BASE_URL } from "./github/config.js";
export { GitHubClient, githubClientLayer, makeGitHubClient, nextPageUrl } from "./github/GitHubClient.js";
export {
  DEFAULT_LISTENER_REGISTRY_PATH,
  DEFAULT_LISTENER_STATE_PATH,
  listenerRegistrySchema,
  parseListenerRegistry,
  planGitHubListenerReconciliation,
  readListenerOwnershipState,
  readListenerRegistry,
  reconcileGitHubListeners,
} from "./github/ListenerRegistry.js";
export {
  decodeGitHubWebhook,
  GITHUB_SOURCE_ID,
  githubWebhookSourceConfig,
  makeGitHubWebhookSource,
} from "./github/GitHubWebhookSource.js";
export {
  githubCorrelationId,
  OnIssueComment,
  OnIssueOpened,
  OnPullRequest,
  OnPush,
  OnWebhook,
} from "./github/components/OnWebhook.js";
export {
  AddLabels,
  Comment,
  CreateIssue,
  CreatePullRequest,
  SetCommitStatus,
  splitRepo,
} from "./github/components/outbound.js";
export * from "./github/schemas.js";
