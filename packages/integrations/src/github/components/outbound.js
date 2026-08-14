// @smithers-type-exports-begin
/** @typedef {import("./outboundProps.ts").GitHubOutboundBaseProps} GitHubOutboundBaseProps */
/** @typedef {import("./outboundProps.ts").CommentProps} CommentProps */
/** @typedef {import("./outboundProps.ts").CreateIssueProps} CreateIssueProps */
/** @typedef {import("./outboundProps.ts").CreatePullRequestProps} CreatePullRequestProps */
/** @typedef {import("./outboundProps.ts").AddLabelsProps} AddLabelsProps */
/** @typedef {import("./outboundProps.ts").SetCommitStatusProps} SetCommitStatusProps */
// @smithers-type-exports-end

import React from "react";
import { Effect } from "effect";
import { SmithersContext } from "@smthrs/react-reconciler/context";
import { SmithersError } from "@smthrs/errors/SmithersError";
import { Task } from "@smthrs/components";
import { IntegrationError } from "../../core/IntegrationError.js";
import { makeGitHubClient } from "../GitHubClient.js";

/**
 * Split `owner/repo`, failing loudly on malformed input (ported from
 * Eliza plugin-github's `splitRepo`).
 * @param {string} repo
 * @returns {{ owner: string; name: string }}
 */
export function splitRepo(repo) {
  const parts = typeof repo === "string" ? repo.split("/") : [];
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new IntegrationError("delivery-failed", `GitHub repo must be "owner/repo", got: ${JSON.stringify(repo)}`, {
      repo,
    });
  }
  return { owner: parts[0], name: parts[1] };
}

/**
 * Resolve a value-or-function prop against resolved deps.
 * @template T
 * @param {T | ((deps: Record<string, any>) => T)} value
 * @param {Record<string, any>} deps
 * @returns {T}
 */
function fromDeps(value, deps) {
  return typeof value === "function" ? /** @type {(deps: Record<string, any>) => T} */ (value)(deps) : value;
}

/**
 * @param {Record<string, unknown> | undefined} deps
 * @param {Record<string, string> | undefined} needs
 * @returns {string[] | undefined}
 */
function deriveDepNodeIds(deps, needs) {
  if (!deps) return undefined;
  const ids = new Set();
  for (const key of Object.keys(deps)) {
    ids.add(needs?.[key] ?? key);
  }
  return ids.size > 0 ? [...ids] : undefined;
}

/**
 * Shared frame for outbound GitHub components.
 *
 * VERIFIED against Task.js (lines 200–287): function children are compiled to
 * `__smithersKind: "compute"` ONLY when the Task has neither `agent` nor
 * `deps` — with `deps`, Task calls `children(resolvedDeps)` at render time
 * and treats the RESULT as a static payload. So this wrapper resolves `deps`
 * itself (Task's own `resolveDeps` semantics: `ctx.outputMaybe` per key,
 * defer by rendering nothing until every dep resolves) and renders a Task
 * with NO `deps` prop and a zero-arg function child — guaranteed compute
 * kind; the HTTP call runs at execution time inside the engine, not at
 * render time.
 *
 * @param {GitHubOutboundBaseProps} props
 * @param {(deps: Record<string, any>) => {
 *   method: import("../GitHubClientService.ts").GitHubRequestMethod;
 *   path: string;
 *   body?: unknown;
 *   mapResponse: (response: any) => Record<string, unknown>;
 * }} buildRequest
 * @returns {React.ReactElement | null}
 */
function githubComputeTask(props, buildRequest) {
  if (props.skipIf) return null;
  const smithersContext = props.smithersContext ?? SmithersContext;
  const ctx = React.useContext(smithersContext);
  const depNodeIds = deriveDepNodeIds(props.deps, props.needs);
  /** @type {Record<string, any>} */
  let resolvedDeps = Object.create(null);
  if (props.deps) {
    if (!ctx) {
      throw new SmithersError(
        "CONTEXT_OUTSIDE_WORKFLOW",
        "GitHub outbound component deps require a workflow context. Build the workflow with createSmithers().",
      );
    }
    for (const key of Object.keys(props.deps)) {
      const nodeId = props.needs?.[key] ?? key;
      const value = ctx.outputMaybe(props.deps[key], { nodeId });
      if (value === undefined) {
        // Upstream output not there yet — defer exactly like Task does.
        ctx.recordDeferredDep?.(props.id, depNodeIds ?? []);
        return null;
      }
      resolvedDeps[key] = value;
    }
  }
  const spec = buildRequest(resolvedDeps);
  const config = props.__config;
  const mergedDependsOn = [...new Set([...(props.dependsOn ?? []), ...(depNodeIds ?? [])])];
  return React.createElement(
    Task,
    {
      id: props.id,
      key: props.key,
      output: /** @type {any} */ (props.output),
      dependsOn: mergedDependsOn.length > 0 ? mergedDependsOn : undefined,
      retryPolicy: /** @type {any} */ (props.retryPolicy),
      timeoutMs: props.timeoutMs,
      async: props.async,
      label: props.label,
      smithersContext: props.smithersContext,
    },
    // Zero-arg function child on a Task without agent/deps → compute kind.
    () =>
      Effect.runPromise(makeGitHubClient(config).request(spec.method, spec.path, spec.body)).then((response) =>
        spec.mapResponse(response),
      ),
  );
}

/**
 * Comment on an issue or pull request
 * (`POST /repos/{owner}/{repo}/issues/{number}/comments`; GitHub uses the
 * issues endpoint for PR conversation comments too). Output row:
 * `{ id, url }` (see `GitHubCommentOutputSchema`).
 * @param {CommentProps} props
 */
export function Comment(props) {
  return githubComputeTask(props, (deps) => {
    const repo = splitRepo(fromDeps(props.repo, deps));
    const number = fromDeps(props.number, deps);
    const body = fromDeps(props.body, deps);
    return {
      method: "POST",
      path: `/repos/${repo.owner}/${repo.name}/issues/${number}/comments`,
      body: { body },
      mapResponse: (response) => ({
        id: Number(response?.id),
        url: String(response?.html_url ?? response?.url ?? ""),
      }),
    };
  });
}

/**
 * Create an issue (`POST /repos/{owner}/{repo}/issues`). Output row:
 * `{ number, url }` (see `GitHubIssueOutputSchema`).
 * @param {CreateIssueProps} props
 */
export function CreateIssue(props) {
  return githubComputeTask(props, (deps) => {
    const repo = splitRepo(fromDeps(props.repo, deps));
    return {
      method: "POST",
      path: `/repos/${repo.owner}/${repo.name}/issues`,
      body: {
        title: fromDeps(props.title, deps),
        body: fromDeps(props.body, deps),
        labels: fromDeps(props.labels, deps),
        assignees: fromDeps(props.assignees, deps),
      },
      mapResponse: (response) => ({
        number: Number(response?.number),
        url: String(response?.html_url ?? ""),
      }),
    };
  });
}

/**
 * Open a pull request (`POST /repos/{owner}/{repo}/pulls`). Output row:
 * `{ number, url }` (see `GitHubPullRequestOutputSchema`).
 * @param {CreatePullRequestProps} props
 */
export function CreatePullRequest(props) {
  return githubComputeTask(props, (deps) => {
    const repo = splitRepo(fromDeps(props.repo, deps));
    return {
      method: "POST",
      path: `/repos/${repo.owner}/${repo.name}/pulls`,
      body: {
        title: fromDeps(props.title, deps),
        head: fromDeps(props.head, deps),
        base: fromDeps(props.base, deps),
        body: fromDeps(props.body, deps),
        draft: fromDeps(props.draft, deps),
      },
      mapResponse: (response) => ({
        number: Number(response?.number),
        url: String(response?.html_url ?? ""),
      }),
    };
  });
}

/**
 * Add labels to an issue/PR
 * (`POST /repos/{owner}/{repo}/issues/{number}/labels`). Output row:
 * `{ labels }` — comma-joined label names (see `GitHubLabelsOutputSchema`).
 * @param {AddLabelsProps} props
 */
export function AddLabels(props) {
  return githubComputeTask(props, (deps) => {
    const repo = splitRepo(fromDeps(props.repo, deps));
    const number = fromDeps(props.number, deps);
    return {
      method: "POST",
      path: `/repos/${repo.owner}/${repo.name}/issues/${number}/labels`,
      body: { labels: fromDeps(props.labels, deps) },
      mapResponse: (response) => ({
        labels: Array.isArray(response) ? response.map((label) => String(label?.name ?? "")).join(",") : "",
      }),
    };
  });
}

/**
 * Set a commit status (`POST /repos/{owner}/{repo}/statuses/{sha}`). Output
 * row: `{ state, url }` (see `GitHubCommitStatusOutputSchema`).
 * @param {SetCommitStatusProps} props
 */
export function SetCommitStatus(props) {
  return githubComputeTask(props, (deps) => {
    const repo = splitRepo(fromDeps(props.repo, deps));
    const sha = fromDeps(props.sha, deps);
    return {
      method: "POST",
      path: `/repos/${repo.owner}/${repo.name}/statuses/${sha}`,
      body: {
        state: fromDeps(props.state, deps),
        context: fromDeps(props.context, deps),
        description: fromDeps(props.description, deps),
        target_url: fromDeps(props.targetUrl, deps),
      },
      mapResponse: (response) => ({
        state: String(response?.state ?? ""),
        url: String(response?.url ?? ""),
      }),
    };
  });
}
