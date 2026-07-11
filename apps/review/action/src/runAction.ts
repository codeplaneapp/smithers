#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  linkSync,
  mkdtempSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createSession } from "./createSession";
import { fetchOidcToken } from "./fetchOidcToken";
import { gateEvent } from "./gateEvent";
import { startInferenceBroker } from "./inferenceBroker";
import { resolveInferenceEnv } from "./resolveInferenceEnv";
import { reviewCredentialPolicy } from "./reviewTrustPolicy";
import { runReview } from "./runReview";
import { readWalkthroughFile, uploadWalkthrough } from "../../src/cli/publishWalkthrough";
import { runGh } from "../../src/github/runGh";
import { resolvePullRequest, type PullRequestTarget } from "../../src/github/resolvePullRequest";

interface ReviewSummary {
  files?: number;
  findings?: number;
  inline?: number;
  walkthroughUrl?: string;
  walkthroughPath?: string;
  publishError?: string;
  failedFileReviews?: number;
  questions?: number;
  impact?: string;
}

interface Obj { [key: string]: unknown }

function obj(value: unknown): Obj | null {
  return value !== null && typeof value === "object" ? value as Obj : null;
}

function readSummary(path: string): ReviewSummary | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ReviewSummary;
  } catch {
    return null;
  }
}

function setOutput(key: string, value: string): void {
  const path = process.env.GITHUB_OUTPUT;
  if (path) appendFileSync(path, `${key}=${value}\n`);
}

export function writeReviewArtifact(path: string, value: unknown): void {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > 1_000_000) throw new Error("review artifact exceeds 1 MB");
  const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`;
  const fd = openSync(
    temporaryPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  let closed = false;
  let published = false;
  try {
    if (!fstatSync(fd).isFile()) throw new Error("review artifact destination is not a regular file");
    fchmodSync(fd, 0o600);
    // This is the action's single intentional network-derived artifact sink.
    // Its temporary sibling is exclusive/no-follow, private, bounded, and
    // atomically linked only after the complete JSON document is closed. The
    // no-replace link also rejects every pre-existing final path or symlink.
    // codeql[js/http-to-file-access]
    writeFileSync(fd, json);
    closeSync(fd);
    closed = true;
    linkSync(temporaryPath, path);
    published = true;
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The complete private final artifact is already published. A leftover
      // private sibling is preferable to turning success into ambiguity.
    }
  } finally {
    if (!closed) closeSync(fd);
    if (!published) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // Preserve the primary validation/write failure.
      }
    }
  }
}

function requireSameHttpsOrigin(value: string, expectedOrigin: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} is not a valid URL`);
  }
  if (url.protocol !== "https:" || url.origin !== expectedOrigin) {
    throw new Error(`${label} must use the configured review service HTTPS origin`);
  }
  return url;
}

export { readWalkthroughFile };

function eventPullRequestTarget(payload: unknown, repository: string): PullRequestTarget | null {
  const pr = obj(obj(payload)?.pull_request);
  const head = obj(pr?.head);
  const base = obj(pr?.base);
  const number = pr?.number;
  const headSha = head?.sha;
  const headRef = head?.ref;
  const baseRef = base?.ref;
  if (
    typeof number !== "number" || !Number.isInteger(number) || number <= 0
    || typeof headSha !== "string" || !headSha
    || typeof headRef !== "string" || !headRef
    || typeof baseRef !== "string" || !baseRef
    || !repository.includes("/")
  ) return null;
  const [owner, repo] = repository.split("/", 2);
  return {
    owner,
    repo,
    number,
    url: typeof pr?.html_url === "string" ? pr.html_url : `https://github.com/${repository}/pull/${number}`,
    baseRefName: baseRef,
    headRefName: headRef,
    headSha,
    title: typeof pr?.title === "string" ? pr.title : "",
    body: typeof pr?.body === "string" ? pr.body : "",
  };
}

export function pullRequestReference(
  immutableTarget: PullRequestTarget | null,
  prNumber: number,
): string {
  return immutableTarget?.url ?? String(prNumber);
}

export function prCheckoutEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...env,
    GH_TOKEN: env.GH_TOKEN ?? "",
    GIT_LFS_SKIP_SMUDGE: "1",
  };
}

export function assertNoPersistedGitCredentials(workspace: string): void {
  let sensitiveConfig = "";
  try {
    sensitiveConfig = execFileSync(
      "git",
      ["config", "--local", "--get-regexp", "^(http\\..*\\.extraheader|credential\\..*|credential.helper)$"],
      { cwd: workspace, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status !== 1) throw new Error("could not verify that checkout credentials were removed");
  }
  if (sensitiveConfig.trim()) {
    throw new Error("checkout left an HTTP header or credential helper in .git/config; refusing to start agents");
  }
}

const QUIZ_MODES = new Set(["off", "auto", "on"]);

function resolveQuizMode(input: string | undefined, sessionQuiz: unknown): "off" | "auto" | "on" | undefined {
  const explicit = input?.trim().toLowerCase();
  if (explicit && QUIZ_MODES.has(explicit)) return explicit as "off" | "auto" | "on";
  if (explicit) console.log(`::warning::smithers review: ignoring invalid quiz input "${explicit}" (expected off|auto|on)`);
  if (typeof sessionQuiz === "string" && QUIZ_MODES.has(sessionQuiz)) return sessionQuiz as "off" | "auto" | "on";
  return undefined;
}

/**
 * Analysis-phase entrypoint. This job has read-only GitHub authority. It
 * resolves/fetches PR metadata before the agent starts, replaces `gh` with a
 * read-only replay/capture shim, and emits an untrusted review artifact for a
 * separate write-only publisher job to validate and post.
 */
async function main(): Promise<void> {
  setOutput("has-review", "false");
  const serviceUrl = process.env.SMITHERS_REVIEW_SERVICE_URL ?? "https://review.jjhub.tech";
  const actionPath = process.env.SMITHERS_ACTION_PATH ?? process.cwd();
  const smithersRoot = resolve(actionPath, "..", "..", "..");
  const workspace = process.env.SMITHERS_REVIEW_WORKSPACE ?? process.env.GITHUB_WORKSPACE ?? process.cwd();
  const baseWorkspace = process.env.SMITHERS_REVIEW_BASE_WORKSPACE ?? "";
  const eventName = process.env.GITHUB_EVENT_NAME ?? "";
  const eventPath = process.env.GITHUB_EVENT_PATH ?? "";
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const oidcRequestEnv = {
    ACTIONS_ID_TOKEN_REQUEST_URL: process.env.ACTIONS_ID_TOKEN_REQUEST_URL,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
  };
  // Subscription variables are ignored unconditionally. The OIDC request
  // capability is copied locally and removed before any helper is spawned.
  delete process.env.CODEX_AUTH_JSON;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!eventPath) {
    console.log("::notice::smithers review skipped: GITHUB_EVENT_PATH is empty");
    return;
  }
  if (!repository) throw new Error("GITHUB_REPOSITORY is required");

  const payload = JSON.parse(readFileSync(eventPath, "utf8")) as unknown;
  const decision = gateEvent({ eventName, payload });
  if (!decision.run) {
    console.log(`::notice::smithers review skipped: ${decision.reason}`);
    return;
  }
  const serviceOrigin = requireSameHttpsOrigin(serviceUrl, new URL(serviceUrl).origin, "review service URL").origin;

  const immutableTarget = eventName === "pull_request" || eventName === "pull_request_target"
    ? eventPullRequestTarget(payload, repository)
    : null;
  if ((eventName === "pull_request" || eventName === "pull_request_target") && !immutableTarget) {
    throw new Error("pull request payload is missing immutable target metadata");
  }

  // Resolve the live PR with the analysis job's read-only token. For a
  // pull_request event, require it still to match the event SHA; stale runs
  // must not review or publish a newer head accidentally.
  // A pull_request_target checkout points origin at the fork head. Qualify the
  // lookup with the immutable base-repository PR URL so gh cannot resolve the
  // same number against that fork remote.
  const liveTarget = await resolvePullRequest(
    workspace,
    pullRequestReference(immutableTarget, decision.prNumber),
  );
  const target = immutableTarget ?? liveTarget;
  if (`${liveTarget.owner}/${liveTarget.repo}` !== repository || liveTarget.number !== decision.prNumber) {
    throw new Error("resolved pull request does not match the workflow repository/event");
  }
  if (liveTarget.baseRefName !== "main") {
    console.log("::notice::smithers review skipped: this workflow reviews only pull requests targeting main");
    return;
  }
  if (immutableTarget && liveTarget.headSha !== immutableTarget.headSha) {
    throw new Error(`pull request head moved from ${immutableTarget.headSha} to ${liveTarget.headSha}; refusing stale review`);
  }

  if (decision.eventName === "issue_comment") {
    execFileSync(process.env.SMITHERS_GH_BIN || "gh", ["pr", "checkout", String(decision.prNumber), "--detach"], {
      cwd: workspace,
      stdio: "inherit",
      env: prCheckoutEnvironment(),
    });
    const checkedOutHead = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: workspace,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (checkedOutHead !== target.headSha) {
      throw new Error("checked-out pull request head does not match the immutable resolved head");
    }
  }

  const oidcToken = await fetchOidcToken({ env: oidcRequestEnv });
  const session = await createSession({ serviceUrl, oidcToken, pr: decision.prNumber });
  if (session.status === "quota-exhausted") {
    console.log(`::notice::smithers review skipped: this repo's monthly PR quota is spent (${session.message})`);
    return;
  }
  if (session.status === "not-registered") {
    console.log(`::notice::smithers review skipped: repository is not registered (${session.message})`);
    return;
  }
  if (session.status === "error") throw new Error(`/api/sessions failed: ${session.message}`);
  requireSameHttpsOrigin(session.anthropicBaseUrl, serviceOrigin, "session inference URL");
  requireSameHttpsOrigin(session.publishUrl, serviceOrigin, "session publish URL");
  if ((decision.eventName === "pull_request" || decision.eventName === "pull_request_target") && session.mode === "comment") {
    console.log('::notice::smithers review skipped: repo is in comment mode; comment "@smithers review" to run it');
    return;
  }

  if (!baseWorkspace) throw new Error("SMITHERS_REVIEW_BASE_WORKSPACE is required");
  const baseHead = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: baseWorkspace,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const eventBaseSha = obj(obj(obj(payload)?.pull_request)?.base)?.sha;
  if (typeof eventBaseSha === "string" && eventBaseSha !== baseHead) {
    throw new Error("checked-out base snapshot does not match the immutable event base SHA");
  }
  execFileSync("git", ["fetch", "--no-tags", baseWorkspace, baseHead], {
    cwd: workspace,
    stdio: "ignore",
  });
  execFileSync("git", ["update-ref", `refs/remotes/origin/${target.baseRefName}`, baseHead], {
    cwd: workspace,
    stdio: "ignore",
  });

  const filesJsonLines = await runGh(workspace, [
    "api",
    "--paginate",
    `repos/${repository}/pulls/${decision.prNumber}/files`,
    "--jq",
    ".[] | {filename, additions, deletions, patch} | @json",
  ]);
  const tempRoot = process.env.RUNNER_TEMP?.trim() || tmpdir();
  const sandboxRoot = mkdtempSync(join(tempRoot, "smithers-review-sandbox-"));
  const fixturePath = join(sandboxRoot, "github-fixture.json");
  const capturePath = join(sandboxRoot, "captured-review.json");
  const summaryPath = join(sandboxRoot, "summary.json");
  const artifactPath = join(tempRoot, `smithers-review-artifact-${process.pid}.json`);
  writeFileSync(fixturePath, JSON.stringify({
    repository,
    prNumber: decision.prNumber,
    prView: {
      number: target.number,
      url: target.url,
      baseRefName: target.baseRefName,
      headRefName: target.headRefName,
      headRefOid: target.headSha,
      title: target.title,
      body: target.body,
    },
    filesJsonLines,
  }), { mode: 0o600 });
  assertNoPersistedGitCredentials(workspace);

  const trust = reviewCredentialPolicy();
  const broker = startInferenceBroker({
    upstreamBaseUrl: session.anthropicBaseUrl,
    sessionToken: session.token,
  });
  const inference = resolveInferenceEnv({
    anthropicBaseUrl: broker.baseUrl,
    sessionToken: broker.clientKey,
  });

  // Nothing below this line receives the analysis job's GitHub or OIDC
  // request tokens. The CLI gets only the explicit replay fixture and the
  // short-lived metered inference session.
  for (const key of [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "ACTIONS_ID_TOKEN_REQUEST_URL",
  ]) delete process.env[key];

  console.log(`smithers review: ${inference.mode} (${trust.reason})`);
  let exitCode: number;
  try {
    exitCode = await runReview({
      smithersRoot,
      actionPath,
      workspace,
      prNumber: decision.prNumber,
      inferenceEnv: inference.env,
      ghFixturePath: fixturePath,
      capturePath,
      outputDir: sandboxRoot,
      quiz: resolveQuizMode(process.env.SMITHERS_REVIEW_QUIZ, session.quiz),
      summaryPath,
    });
  } finally {
    broker.stop();
  }
  if (exitCode !== 0) process.exit(exitCode);

  const summary = readSummary(summaryPath);
  let walkthroughUrl = "";
  const producedWalkthrough = Boolean(summary?.walkthroughPath);
  if (summary) delete summary.walkthroughPath;
  if (producedWalkthrough) {
    try {
      walkthroughUrl = await uploadWalkthrough(
        // Never dereference a path selected by the untrusted child. The only
        // upload candidate is the exact output path declared before launch,
        // opened without following symlinks after the sandbox UID exits.
        readWalkthroughFile(join(sandboxRoot, "walkthrough.html")),
        session.publishUrl,
        session.token,
        { expectedOrigin: serviceOrigin },
      );
      if (summary) summary.walkthroughUrl = walkthroughUrl;
    } catch (error) {
      if (summary) summary.publishError = (error as Error).message;
      console.log(`::warning::smithers review walkthrough publish failed: ${(error as Error).message.slice(0, 200)}`);
    }
  }

  let review: unknown;
  try {
    review = JSON.parse(readFileSync(capturePath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`review finished without a captured PR payload: ${(error as Error).message}`);
  }
  const reviewObject = obj(review);
  if (walkthroughUrl && typeof reviewObject?.body === "string") {
    const note = `\n\n**Full walkthrough:** ${walkthroughUrl}`;
    const body = reviewObject.body;
    if (body.length + note.length <= 60_000) reviewObject.body = body + note;
  }
  const envelope = {
    schemaVersion: 1,
    repository,
    prNumber: decision.prNumber,
    headSha: target.headSha,
    baseSha: baseHead,
    eventName: decision.eventName,
    review,
    summary,
  };
  writeReviewArtifact(artifactPath, envelope);

  const artifactName = `smithers-review-${repository.replace(/[^A-Za-z0-9_.-]+/g, "-")}-${decision.prNumber}-${target.headSha}`;
  setOutput("has-review", "true");
  setOutput("artifact-path", artifactPath);
  setOutput("artifact-name", artifactName);
  console.log(`smithers review: analysis complete for ${repository}#${decision.prNumber}; queued for isolated publication`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`smithers review action: ${(error as Error).message ?? String(error)}`);
    process.exit(1);
  });
}
