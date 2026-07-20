import { CommentOnIssueProps as CommentOnIssueProps$1, CreateIssueProps as CreateIssueProps$1, LinearListenerProps as LinearListenerProps$1, UpdateIssueProps as UpdateIssueProps$1 } from './LinearComponents.js';
import React__default from 'react';
import 'zod';
import './LinearConfig.js';
import './LinearClientTypes.js';
import 'effect';
import '@smithers-orchestrator/errors/SmithersError';

/**
 * Wait for `integration:linear:issue.update`. Correlate on `issueId`
 * (`ENG-123`) or `teamKey` (`ENG`); omit both for a catch-all listener.
 */
declare const OnIssueUpdate: (props: LinearListenerProps) => React__default.ReactElement | null;
/** Wait for `integration:linear:issue.create`. */
declare const OnIssueCreated: (props: LinearListenerProps) => React__default.ReactElement | null;
/** Wait for `integration:linear:comment.create`. */
declare const OnComment: (props: LinearListenerProps) => React__default.ReactElement | null;
/**
 * Create a Linear issue as a deterministic compute Task. Props may be
 * values or `(resolvedDeps) => value` functions when `deps` is set. Output
 * row shape: `linearIssueOutputSchema`.
 * @type {(props: CreateIssueProps) => React.ReactElement | null}
 */
declare const CreateIssue: (props: CreateIssueProps) => React__default.ReactElement | null;
/**
 * Update a Linear issue (by UUID or `ENG-123` identifier) as a compute
 * Task. Output row shape: `linearIssueOutputSchema`.
 * @type {(props: UpdateIssueProps) => React.ReactElement | null}
 */
declare const UpdateIssue: (props: UpdateIssueProps) => React__default.ReactElement | null;
/**
 * Comment on a Linear issue (by UUID or `ENG-123` identifier) as a compute
 * Task. Output row shape: `linearCommentOutputSchema`.
 * @type {(props: CommentOnIssueProps) => React.ReactElement | null}
 */
declare const CommentOnIssue: (props: CommentOnIssueProps) => React__default.ReactElement | null;
type CommentOnIssueProps = CommentOnIssueProps$1;
type CreateIssueProps = CreateIssueProps$1;
type LinearListenerProps = LinearListenerProps$1;
type UpdateIssueProps = UpdateIssueProps$1;

export { CommentOnIssue, type CommentOnIssueProps, CreateIssue, type CreateIssueProps, type LinearListenerProps, OnComment, OnIssueCreated, OnIssueUpdate, UpdateIssue, type UpdateIssueProps };
