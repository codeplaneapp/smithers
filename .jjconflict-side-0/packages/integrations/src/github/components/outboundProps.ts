import type React from "react";
import type { GitHubConfig } from "../GitHubConfig.ts";

/**
 * A prop that is either a literal value or derived from resolved deps
 * (`deps` prop): the component resolves deps itself, then calls the function.
 */
export type FromDeps<T> = T | ((deps: Record<string, any>) => T);

/** Retry policy shape accepted by `Task` (mirrored, kept loose). */
export type OutboundRetryPolicy = {
  maxAttempts?: number;
  backoffMs?: number;
  maxBackoffMs?: number;
  [key: string]: unknown;
};

/** Props shared by every outbound GitHub compute-Task component. */
export type GitHubOutboundBaseProps = {
  id: string;
  /** Output table target (from `createSmithers({ outputs })`). */
  output: unknown;
  /** `owner/repo`. */
  repo: FromDeps<string>;
  /** Upstream outputs to derive prop values from (Task-style deps spec). */
  deps?: Record<string, unknown>;
  needs?: Record<string, string>;
  dependsOn?: string[];
  retryPolicy?: OutboundRetryPolicy;
  timeoutMs?: number;
  async?: boolean;
  skipIf?: boolean;
  label?: string;
  key?: string;
  /**
   * Non-public: explicit config injected by a bound createSmithers instance.
   * Wins over `configureGitHub()` and env.
   */
  __config?: GitHubConfig;
  smithersContext?: React.Context<any>;
};

export type CommentProps = GitHubOutboundBaseProps & {
  /** Issue or PR number. */
  number: FromDeps<number>;
  body: FromDeps<string>;
};

export type CreateIssueProps = GitHubOutboundBaseProps & {
  title: FromDeps<string>;
  body?: FromDeps<string | undefined>;
  labels?: FromDeps<string[] | undefined>;
  assignees?: FromDeps<string[] | undefined>;
};

export type CreatePullRequestProps = GitHubOutboundBaseProps & {
  title: FromDeps<string>;
  /** Source branch. */
  head: FromDeps<string>;
  /** Target branch. */
  base: FromDeps<string>;
  body?: FromDeps<string | undefined>;
  draft?: FromDeps<boolean | undefined>;
};

export type AddLabelsProps = GitHubOutboundBaseProps & {
  number: FromDeps<number>;
  labels: FromDeps<string[]>;
};

export type SetCommitStatusProps = GitHubOutboundBaseProps & {
  sha: FromDeps<string>;
  state: FromDeps<"error" | "failure" | "pending" | "success">;
  context?: FromDeps<string | undefined>;
  description?: FromDeps<string | undefined>;
  targetUrl?: FromDeps<string | undefined>;
};
