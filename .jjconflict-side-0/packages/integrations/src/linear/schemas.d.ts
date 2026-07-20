import { z } from 'zod';

/** Entity `data` for an Issue webhook (`type: "Issue"`). */
declare const linearIssueDataSchema: z.ZodObject<{
    id: z.ZodString;
    identifier: z.ZodOptional<z.ZodString>;
    title: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    priority: z.ZodOptional<z.ZodNumber>;
    url: z.ZodOptional<z.ZodString>;
    team: z.ZodOptional<z.ZodObject<{
        id: z.ZodString;
        key: z.ZodOptional<z.ZodString>;
        name: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>>;
    state: z.ZodOptional<z.ZodObject<{
        id: z.ZodString;
        name: z.ZodOptional<z.ZodString>;
        type: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>>;
}, z.core.$loose>;
/** Entity `data` for a Comment webhook (`type: "Comment"`). */
declare const linearCommentDataSchema: z.ZodObject<{
    id: z.ZodString;
    body: z.ZodOptional<z.ZodString>;
    issueId: z.ZodOptional<z.ZodString>;
    issue: z.ZodOptional<z.ZodObject<{
        id: z.ZodString;
        identifier: z.ZodOptional<z.ZodString>;
        title: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>>;
}, z.core.$loose>;
/**
 * Full Linear webhook delivery: `{ action, type, data, updatedFrom?, url?,
 * webhookId?, webhookTimestamp?, organizationId? }`. `updatedFrom` carries
 * the previous values of changed fields on `action: "update"`.
 */
declare const linearWebhookPayloadSchema: z.ZodObject<{
    action: z.ZodString;
    type: z.ZodString;
    data: z.ZodObject<{
        id: z.ZodString;
    }, z.core.$loose>;
    updatedFrom: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    url: z.ZodOptional<z.ZodString>;
    webhookId: z.ZodOptional<z.ZodString>;
    webhookTimestamp: z.ZodOptional<z.ZodNumber>;
    organizationId: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
/** Issue webhook delivery (listener payload for OnIssueUpdate/OnIssueCreated). */
declare const linearIssueEventSchema: z.ZodObject<{
    action: z.ZodString;
    type: z.ZodString;
    updatedFrom: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    url: z.ZodOptional<z.ZodString>;
    webhookId: z.ZodOptional<z.ZodString>;
    webhookTimestamp: z.ZodOptional<z.ZodNumber>;
    organizationId: z.ZodOptional<z.ZodString>;
    data: z.ZodObject<{
        id: z.ZodString;
        identifier: z.ZodOptional<z.ZodString>;
        title: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        priority: z.ZodOptional<z.ZodNumber>;
        url: z.ZodOptional<z.ZodString>;
        team: z.ZodOptional<z.ZodObject<{
            id: z.ZodString;
            key: z.ZodOptional<z.ZodString>;
            name: z.ZodOptional<z.ZodString>;
        }, z.core.$loose>>;
        state: z.ZodOptional<z.ZodObject<{
            id: z.ZodString;
            name: z.ZodOptional<z.ZodString>;
            type: z.ZodOptional<z.ZodString>;
        }, z.core.$loose>>;
    }, z.core.$loose>;
}, z.core.$loose>;
/** Comment webhook delivery (listener payload for OnComment). */
declare const linearCommentEventSchema: z.ZodObject<{
    action: z.ZodString;
    type: z.ZodString;
    updatedFrom: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    url: z.ZodOptional<z.ZodString>;
    webhookId: z.ZodOptional<z.ZodString>;
    webhookTimestamp: z.ZodOptional<z.ZodNumber>;
    organizationId: z.ZodOptional<z.ZodString>;
    data: z.ZodObject<{
        id: z.ZodString;
        body: z.ZodOptional<z.ZodString>;
        issueId: z.ZodOptional<z.ZodString>;
        issue: z.ZodOptional<z.ZodObject<{
            id: z.ZodString;
            identifier: z.ZodOptional<z.ZodString>;
            title: z.ZodOptional<z.ZodString>;
        }, z.core.$loose>>;
    }, z.core.$loose>;
}, z.core.$loose>;
/**
 * Output of the outbound CreateIssue/UpdateIssue components (register as a
 * createSmithers output schema). Exactly the columns the compute task
 * writes.
 */
declare const linearIssueOutputSchema: z.ZodObject<{
    id: z.ZodString;
    identifier: z.ZodString;
    title: z.ZodString;
    url: z.ZodString;
}, z.core.$strip>;
/** Output of the outbound CommentOnIssue component. */
declare const linearCommentOutputSchema: z.ZodObject<{
    id: z.ZodString;
    body: z.ZodString;
    issueId: z.ZodString;
    issueIdentifier: z.ZodString;
}, z.core.$strip>;

export { linearCommentDataSchema, linearCommentEventSchema, linearCommentOutputSchema, linearIssueDataSchema, linearIssueEventSchema, linearIssueOutputSchema, linearWebhookPayloadSchema };
