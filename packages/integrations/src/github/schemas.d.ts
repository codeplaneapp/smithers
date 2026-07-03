import { z } from 'zod';

declare const GitHubUserSchema: z.ZodObject<{
    login: z.ZodString;
    id: z.ZodOptional<z.ZodNumber>;
}, z.core.$loose>;
declare const GitHubRepositorySchema: z.ZodObject<{
    full_name: z.ZodString;
    name: z.ZodOptional<z.ZodString>;
    owner: z.ZodOptional<z.ZodObject<{
        login: z.ZodString;
        id: z.ZodOptional<z.ZodNumber>;
    }, z.core.$loose>>;
    default_branch: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
declare const GitHubPullRequestSchema: z.ZodObject<{
    number: z.ZodNumber;
    title: z.ZodOptional<z.ZodString>;
    state: z.ZodOptional<z.ZodString>;
    html_url: z.ZodOptional<z.ZodString>;
    body: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    draft: z.ZodOptional<z.ZodBoolean>;
    merged: z.ZodOptional<z.ZodBoolean>;
    user: z.ZodOptional<z.ZodObject<{
        login: z.ZodString;
        id: z.ZodOptional<z.ZodNumber>;
    }, z.core.$loose>>;
    head: z.ZodOptional<z.ZodObject<{
        ref: z.ZodString;
        sha: z.ZodString;
    }, z.core.$loose>>;
    base: z.ZodOptional<z.ZodObject<{
        ref: z.ZodString;
        sha: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>>;
}, z.core.$loose>;
declare const GitHubIssueSchema: z.ZodObject<{
    number: z.ZodNumber;
    title: z.ZodOptional<z.ZodString>;
    state: z.ZodOptional<z.ZodString>;
    html_url: z.ZodOptional<z.ZodString>;
    body: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    user: z.ZodOptional<z.ZodObject<{
        login: z.ZodString;
        id: z.ZodOptional<z.ZodNumber>;
    }, z.core.$loose>>;
    labels: z.ZodOptional<z.ZodArray<z.ZodUnknown>>;
}, z.core.$loose>;
declare const GitHubCommentSchema: z.ZodObject<{
    id: z.ZodOptional<z.ZodNumber>;
    body: z.ZodOptional<z.ZodString>;
    html_url: z.ZodOptional<z.ZodString>;
    user: z.ZodOptional<z.ZodObject<{
        login: z.ZodString;
        id: z.ZodOptional<z.ZodNumber>;
    }, z.core.$loose>>;
}, z.core.$loose>;
/** `pull_request` webhook payload (validated fields only; rest passthrough). */
declare const GitHubPullRequestEventSchema: z.ZodObject<{
    action: z.ZodString;
    number: z.ZodOptional<z.ZodNumber>;
    pull_request: z.ZodObject<{
        number: z.ZodNumber;
        title: z.ZodOptional<z.ZodString>;
        state: z.ZodOptional<z.ZodString>;
        html_url: z.ZodOptional<z.ZodString>;
        body: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        draft: z.ZodOptional<z.ZodBoolean>;
        merged: z.ZodOptional<z.ZodBoolean>;
        user: z.ZodOptional<z.ZodObject<{
            login: z.ZodString;
            id: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        head: z.ZodOptional<z.ZodObject<{
            ref: z.ZodString;
            sha: z.ZodString;
        }, z.core.$loose>>;
        base: z.ZodOptional<z.ZodObject<{
            ref: z.ZodString;
            sha: z.ZodOptional<z.ZodString>;
        }, z.core.$loose>>;
    }, z.core.$loose>;
    repository: z.ZodObject<{
        full_name: z.ZodString;
        name: z.ZodOptional<z.ZodString>;
        owner: z.ZodOptional<z.ZodObject<{
            login: z.ZodString;
            id: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        default_branch: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>;
    sender: z.ZodOptional<z.ZodObject<{
        login: z.ZodString;
        id: z.ZodOptional<z.ZodNumber>;
    }, z.core.$loose>>;
}, z.core.$loose>;
/** `issues` webhook payload. */
declare const GitHubIssuesEventSchema: z.ZodObject<{
    action: z.ZodString;
    issue: z.ZodObject<{
        number: z.ZodNumber;
        title: z.ZodOptional<z.ZodString>;
        state: z.ZodOptional<z.ZodString>;
        html_url: z.ZodOptional<z.ZodString>;
        body: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        user: z.ZodOptional<z.ZodObject<{
            login: z.ZodString;
            id: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        labels: z.ZodOptional<z.ZodArray<z.ZodUnknown>>;
    }, z.core.$loose>;
    repository: z.ZodObject<{
        full_name: z.ZodString;
        name: z.ZodOptional<z.ZodString>;
        owner: z.ZodOptional<z.ZodObject<{
            login: z.ZodString;
            id: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        default_branch: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>;
    sender: z.ZodOptional<z.ZodObject<{
        login: z.ZodString;
        id: z.ZodOptional<z.ZodNumber>;
    }, z.core.$loose>>;
}, z.core.$loose>;
/** `issue_comment` webhook payload. */
declare const GitHubIssueCommentEventSchema: z.ZodObject<{
    action: z.ZodString;
    issue: z.ZodObject<{
        number: z.ZodNumber;
        title: z.ZodOptional<z.ZodString>;
        state: z.ZodOptional<z.ZodString>;
        html_url: z.ZodOptional<z.ZodString>;
        body: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        user: z.ZodOptional<z.ZodObject<{
            login: z.ZodString;
            id: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        labels: z.ZodOptional<z.ZodArray<z.ZodUnknown>>;
    }, z.core.$loose>;
    comment: z.ZodObject<{
        id: z.ZodOptional<z.ZodNumber>;
        body: z.ZodOptional<z.ZodString>;
        html_url: z.ZodOptional<z.ZodString>;
        user: z.ZodOptional<z.ZodObject<{
            login: z.ZodString;
            id: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
    }, z.core.$loose>;
    repository: z.ZodObject<{
        full_name: z.ZodString;
        name: z.ZodOptional<z.ZodString>;
        owner: z.ZodOptional<z.ZodObject<{
            login: z.ZodString;
            id: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        default_branch: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>;
    sender: z.ZodOptional<z.ZodObject<{
        login: z.ZodString;
        id: z.ZodOptional<z.ZodNumber>;
    }, z.core.$loose>>;
}, z.core.$loose>;
/** `push` webhook payload. */
declare const GitHubPushEventSchema: z.ZodObject<{
    ref: z.ZodString;
    before: z.ZodOptional<z.ZodString>;
    after: z.ZodOptional<z.ZodString>;
    repository: z.ZodObject<{
        full_name: z.ZodString;
        name: z.ZodOptional<z.ZodString>;
        owner: z.ZodOptional<z.ZodObject<{
            login: z.ZodString;
            id: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        default_branch: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>;
    commits: z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodOptional<z.ZodString>;
        message: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>>>;
    pusher: z.ZodOptional<z.ZodObject<{
        name: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>>;
}, z.core.$loose>;
/** Fallback payload schema for `OnWebhook` when no schema prop is given. */
declare const GitHubWebhookPayloadSchema: z.ZodObject<{}, z.core.$loose>;
declare const GitHubCommentOutputSchema: z.ZodObject<{
    id: z.ZodNumber;
    url: z.ZodString;
}, z.core.$strip>;
declare const GitHubIssueOutputSchema: z.ZodObject<{
    number: z.ZodNumber;
    url: z.ZodString;
}, z.core.$strip>;
declare const GitHubPullRequestOutputSchema: z.ZodObject<{
    number: z.ZodNumber;
    url: z.ZodString;
}, z.core.$strip>;
declare const GitHubLabelsOutputSchema: z.ZodObject<{
    labels: z.ZodString;
}, z.core.$strip>;
declare const GitHubCommitStatusOutputSchema: z.ZodObject<{
    state: z.ZodString;
    url: z.ZodString;
}, z.core.$strip>;

export { GitHubCommentOutputSchema, GitHubCommentSchema, GitHubCommitStatusOutputSchema, GitHubIssueCommentEventSchema, GitHubIssueOutputSchema, GitHubIssueSchema, GitHubIssuesEventSchema, GitHubLabelsOutputSchema, GitHubPullRequestEventSchema, GitHubPullRequestOutputSchema, GitHubPullRequestSchema, GitHubPushEventSchema, GitHubRepositorySchema, GitHubUserSchema, GitHubWebhookPayloadSchema };
