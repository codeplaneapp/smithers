// @smithers-orchestrator/integrations/github — GitHub integration surface.
//
// Inbound: `makeGitHubWebhookSource` (X-Hub-Signature-256 verified, per-action
// signal fan-out) + declarative listeners (`OnWebhook`, `OnPullRequest`,
// `OnIssueOpened`, `OnIssueComment`, `OnPush`).
// Outbound: deterministic compute-Task components (`Comment`, `CreateIssue`,
// `CreatePullRequest`, `AddLabels`, `SetCommitStatus`) over the Effect-native
// `GitHubClient`. Configure credentials with `configureGitHub` (or env).
export { configureGitHub, DEFAULT_GITHUB_API_BASE_URL } from "./github/config.js";
export { GitHubClient, githubClientLayer, makeGitHubClient, nextPageUrl, } from "./github/GitHubClient.js";
export { decodeGitHubWebhook, GITHUB_SOURCE_ID, githubWebhookSourceConfig, makeGitHubWebhookSource, } from "./github/GitHubWebhookSource.js";
export { githubCorrelationId, OnIssueComment, OnIssueOpened, OnPullRequest, OnPush, OnWebhook, } from "./github/components/OnWebhook.js";
export { AddLabels, Comment, CreateIssue, CreatePullRequest, SetCommitStatus, splitRepo, } from "./github/components/outbound.js";
export * from "./github/schemas.js";
