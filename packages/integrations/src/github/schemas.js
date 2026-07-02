import { z } from "zod";

// GitHub webhook payloads are huge and evolve; every schema here validates
// only the fields we type and passes the rest through untouched, so listener
// render-props get typed access without ever rejecting a real delivery.

export const GitHubUserSchema = z
    .object({
    login: z.string(),
    id: z.number().optional(),
})
    .passthrough();

export const GitHubRepositorySchema = z
    .object({
    full_name: z.string(),
    name: z.string().optional(),
    owner: GitHubUserSchema.optional(),
    default_branch: z.string().optional(),
})
    .passthrough();

export const GitHubPullRequestSchema = z
    .object({
    number: z.number(),
    title: z.string().optional(),
    state: z.string().optional(),
    html_url: z.string().optional(),
    body: z.string().nullable().optional(),
    draft: z.boolean().optional(),
    merged: z.boolean().optional(),
    user: GitHubUserSchema.optional(),
    head: z.object({ ref: z.string(), sha: z.string() }).passthrough().optional(),
    base: z.object({ ref: z.string(), sha: z.string().optional() }).passthrough().optional(),
})
    .passthrough();

export const GitHubIssueSchema = z
    .object({
    number: z.number(),
    title: z.string().optional(),
    state: z.string().optional(),
    html_url: z.string().optional(),
    body: z.string().nullable().optional(),
    user: GitHubUserSchema.optional(),
    labels: z.array(z.unknown()).optional(),
})
    .passthrough();

export const GitHubCommentSchema = z
    .object({
    id: z.number().optional(),
    body: z.string().optional(),
    html_url: z.string().optional(),
    user: GitHubUserSchema.optional(),
})
    .passthrough();

/** `pull_request` webhook payload (validated fields only; rest passthrough). */
export const GitHubPullRequestEventSchema = z
    .object({
    action: z.string(),
    number: z.number().optional(),
    pull_request: GitHubPullRequestSchema,
    repository: GitHubRepositorySchema,
    sender: GitHubUserSchema.optional(),
})
    .passthrough();

/** `issues` webhook payload. */
export const GitHubIssuesEventSchema = z
    .object({
    action: z.string(),
    issue: GitHubIssueSchema,
    repository: GitHubRepositorySchema,
    sender: GitHubUserSchema.optional(),
})
    .passthrough();

/** `issue_comment` webhook payload. */
export const GitHubIssueCommentEventSchema = z
    .object({
    action: z.string(),
    issue: GitHubIssueSchema,
    comment: GitHubCommentSchema,
    repository: GitHubRepositorySchema,
    sender: GitHubUserSchema.optional(),
})
    .passthrough();

/** `push` webhook payload. */
export const GitHubPushEventSchema = z
    .object({
    ref: z.string(),
    before: z.string().optional(),
    after: z.string().optional(),
    repository: GitHubRepositorySchema,
    commits: z.array(z.object({
        id: z.string().optional(),
        message: z.string().optional(),
    }).passthrough()).optional(),
    pusher: z.object({ name: z.string().optional() }).passthrough().optional(),
})
    .passthrough();

/** Fallback payload schema for `OnWebhook` when no schema prop is given. */
export const GitHubWebhookPayloadSchema = z.object({}).passthrough();

// ---------------------------------------------------------------------------
// Outbound component output schemas — the trimmed, flat rows the compute
// tasks return (plug these into `createSmithers({ outputs })`).
// ---------------------------------------------------------------------------

export const GitHubCommentOutputSchema = z.object({
    id: z.number(),
    url: z.string(),
});

export const GitHubIssueOutputSchema = z.object({
    number: z.number(),
    url: z.string(),
});

export const GitHubPullRequestOutputSchema = z.object({
    number: z.number(),
    url: z.string(),
});

export const GitHubLabelsOutputSchema = z.object({
    labels: z.string(),
});

export const GitHubCommitStatusOutputSchema = z.object({
    state: z.string(),
    url: z.string(),
});
