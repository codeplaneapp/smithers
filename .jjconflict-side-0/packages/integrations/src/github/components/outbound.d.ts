import { AddLabelsProps as AddLabelsProps$1, CommentProps as CommentProps$1, CreateIssueProps as CreateIssueProps$1, CreatePullRequestProps as CreatePullRequestProps$1, GitHubOutboundBaseProps as GitHubOutboundBaseProps$1, SetCommitStatusProps as SetCommitStatusProps$1 } from './outboundProps.js';
import React__default from 'react';
import '../GitHubConfig.js';

/**
 * Split `owner/repo`, failing loudly on malformed input (ported from
 * Eliza plugin-github's `splitRepo`).
 * @param {string} repo
 * @returns {{ owner: string; name: string }}
 */
declare function splitRepo(repo: string): {
    owner: string;
    name: string;
};
/**
 * Comment on an issue or pull request
 * (`POST /repos/{owner}/{repo}/issues/{number}/comments`; GitHub uses the
 * issues endpoint for PR conversation comments too). Output row:
 * `{ id, url }` (see `GitHubCommentOutputSchema`).
 * @param {CommentProps} props
 */
declare function Comment(props: CommentProps): React__default.ReactElement<any, string | React__default.JSXElementConstructor<any>> | null;
/**
 * Create an issue (`POST /repos/{owner}/{repo}/issues`). Output row:
 * `{ number, url }` (see `GitHubIssueOutputSchema`).
 * @param {CreateIssueProps} props
 */
declare function CreateIssue(props: CreateIssueProps): React__default.ReactElement<any, string | React__default.JSXElementConstructor<any>> | null;
/**
 * Open a pull request (`POST /repos/{owner}/{repo}/pulls`). Output row:
 * `{ number, url }` (see `GitHubPullRequestOutputSchema`).
 * @param {CreatePullRequestProps} props
 */
declare function CreatePullRequest(props: CreatePullRequestProps): React__default.ReactElement<any, string | React__default.JSXElementConstructor<any>> | null;
/**
 * Add labels to an issue/PR
 * (`POST /repos/{owner}/{repo}/issues/{number}/labels`). Output row:
 * `{ labels }` — comma-joined label names (see `GitHubLabelsOutputSchema`).
 * @param {AddLabelsProps} props
 */
declare function AddLabels(props: AddLabelsProps): React__default.ReactElement<any, string | React__default.JSXElementConstructor<any>> | null;
/**
 * Set a commit status (`POST /repos/{owner}/{repo}/statuses/{sha}`). Output
 * row: `{ state, url }` (see `GitHubCommitStatusOutputSchema`).
 * @param {SetCommitStatusProps} props
 */
declare function SetCommitStatus(props: SetCommitStatusProps): React__default.ReactElement<any, string | React__default.JSXElementConstructor<any>> | null;
type GitHubOutboundBaseProps = GitHubOutboundBaseProps$1;
type CommentProps = CommentProps$1;
type CreateIssueProps = CreateIssueProps$1;
type CreatePullRequestProps = CreatePullRequestProps$1;
type AddLabelsProps = AddLabelsProps$1;
type SetCommitStatusProps = SetCommitStatusProps$1;

export { AddLabels, type AddLabelsProps, Comment, type CommentProps, CreateIssue, type CreateIssueProps, CreatePullRequest, type CreatePullRequestProps, type GitHubOutboundBaseProps, SetCommitStatus, type SetCommitStatusProps, splitRepo };
