#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createSession } from "./createSession";
import { fetchOidcToken } from "./fetchOidcToken";
import { gateEvent } from "./gateEvent";
import { startInferenceBroker } from "./inferenceBroker";
import { validateReviewPayload, type ValidatedReviewPayload } from "./publishReview";
import { resolveInferenceEnv } from "./resolveInferenceEnv";
import { reviewCredentialPolicy } from "./reviewTrustPolicy";
import { runReview } from "./runReview";
import { readWalkthroughFile, uploadWalkthrough } from "../../src/cli/publishWalkthrough";
import { parseCanonicalReviewSummary, type CanonicalReviewSummary } from "../../src/cli/reviewSummary";
import { resolvePullRequest, type PullRequestTarget } from "../../src/github/resolvePullRequest";
import { compareReviewPaths, deriveReviewManifestCapabilities, generateReviewManifest, isSafeReviewPath, manifestChangedFiles, parseReviewManifest, writeProtectedReviewInput, writeProtectedReviewManifest } from "../../src/reviewManifest";

interface Obj { [key: string]: unknown }

function obj(value: unknown): Obj | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Obj : null;
}

function safeWorkflowError(error: unknown, limit = 240): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/@(?!\u200b)/g, "@\u200b")
    .slice(0, limit);
}

function readStableRegularFile(path: string, maxBytes: number, label: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) throw new Error(`${label} is not a regular file`);
    if (before.size === 0 || before.size > maxBytes) throw new Error(`${label} is empty or oversized`);
    const contents = readFileSync(fd);
    const after = fstatSync(fd);
    if (
      contents.byteLength !== before.size || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino || after.dev !== before.dev
    ) throw new Error(`${label} changed while it was being read`);
    return contents;
  } finally {
    closeSync(fd);
  }
}

function decodeUtf8(value: Uint8Array, label: string): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(value); }
  catch { throw new Error(`${label} is not valid UTF-8`); }
}

function readSummary(path: string): CanonicalReviewSummary | null {
  try {
    return parseCanonicalReviewSummary(JSON.parse(decodeUtf8(readStableRegularFile(path, 4 * 1024, "review summary"), "review summary")));
  } catch {
    return null;
  }
}

function setOutput(key: string, value: string): void {
  const path = process.env.GITHUB_OUTPUT;
  if (path) appendFileSync(path, `${key}=${value}\n`);
}

export type SerializedValidatedReviewArtifact = string & {
  readonly __serializedValidatedReviewArtifact: unique symbol;
};

interface ReviewArtifactInput {
  repository: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  eventName: string;
  review: unknown;
  changedFiles: readonly string[];
  /** The protected manifest is the inline-comment capability authority. */
  manifestText: string;
}

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const PUBLICATION_EVENTS = new Set(["pull_request", "pull_request_target", "issue_comment"]);
function safeRepository(value: string): boolean {
  return value.length <= 200 && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)
    && value.split("/").every((part) => part.length <= 100 && part !== "." && part !== "..");
}
/** Validate and rebuild the exact artifact crossing into the publisher job. */
export function serializeValidatedReviewArtifact(
  input: ReviewArtifactInput,
): SerializedValidatedReviewArtifact {
  if (!safeRepository(input.repository)) {
    throw new Error("review artifact repository is invalid");
  }
  if (!Number.isSafeInteger(input.prNumber) || input.prNumber <= 0) {
    throw new Error("review artifact pull request number is invalid");
  }
  if (!SHA.test(input.headSha) || !SHA.test(input.baseSha)) {
    throw new Error("review artifact revision binding is invalid");
  }
  if (!PUBLICATION_EVENTS.has(input.eventName)) {
    throw new Error("review artifact event is invalid");
  }
  const changedFiles = [...input.changedFiles];
  if (changedFiles.length < 1 || changedFiles.length > 3_000 || new Set(changedFiles).size !== changedFiles.length
    || changedFiles.some((file) => !isSafeReviewPath(file))
    || changedFiles.some((file, index) => index > 0 && compareReviewPaths(changedFiles[index - 1], file) >= 0)) {
    throw new Error("review artifact changedFiles must be canonical, unique, sorted, and bounded");
  }
  const changedFileSet = new Set(changedFiles);
  const manifest = parseReviewManifest(input.manifestText);
  const manifestFiles = manifest.map((item) => item.filename);
  if (manifestFiles.length !== changedFiles.length || manifestFiles.some((file, i) => file !== changedFiles[i])) {
    throw new Error("review artifact changedFiles do not exactly bind the immutable manifest");
  }
  const capabilities = new Map(manifest.map((item) => [
    item.filename,
    deriveReviewManifestCapabilities(item).rightLines,
  ]));
  const review: ValidatedReviewPayload = validateReviewPayload(
    input.review,
    input.headSha,
    changedFileSet,
    capabilities,
  );
  const envelope = {
    schemaVersion: 2 as const,
    repository: input.repository,
    prNumber: input.prNumber,
    headSha: input.headSha,
    baseSha: input.baseSha,
    eventName: input.eventName,
    changedFiles: [...changedFiles].sort(compareReviewPaths),
    review,
  };
  const json = JSON.stringify(envelope);
  if (Buffer.byteLength(json) > 1_000_000) throw new Error("review artifact exceeds 1 MB");
  return json as SerializedValidatedReviewArtifact;
}

export function writeReviewArtifact(path: string, json: SerializedValidatedReviewArtifact): void {
  if (typeof json !== "string" || Buffer.byteLength(json) > 1_000_000) {
    throw new Error("review artifact is invalid or exceeds 1 MB");
  }
  const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`;
  const fd = openSync(
    temporaryPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  let closed = false;
  let published = false;
  try {
    const created = fstatSync(fd);
    if (!created.isFile()) throw new Error("review artifact destination is not a regular file");
    fchmodSync(fd, 0o600);
    const bytes = Buffer.from(json);
    for (let offset = 0; offset < bytes.length;) {
      const count = writeSync(fd, bytes, offset, bytes.length - offset);
      if (count <= 0) throw new Error("review artifact write did not make progress");
      offset += count;
    }
    fsyncSync(fd);
    const written = fstatSync(fd);
    if (written.dev !== created.dev || written.ino !== created.ino || written.size !== bytes.byteLength) {
      throw new Error("review artifact changed while being written");
    }
    closeSync(fd);
    closed = true;
    linkSync(temporaryPath, path);
    const source = lstatSync(temporaryPath);
    const destination = lstatSync(path);
    if (!destination.isFile() || source.dev !== destination.dev || source.ino !== destination.ino) {
      throw new Error("review artifact pathname was replaced while being published");
    }
    published = true;
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The complete private final artifact is already published. A leftover
      // private sibling is preferable to turning success into ambiguity.
    }
    try {
      const directory = openSync(dirname(path), constants.O_RDONLY);
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EOPNOTSUPP") throw error;
    }
    const durable = lstatSync(path);
    if (!durable.isFile() || durable.dev !== destination.dev || durable.ino !== destination.ino
      || durable.size !== bytes.byteLength || (durable.mode & 0o077) !== 0) {
      throw new Error("review artifact changed while its directory was synchronized");
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

export function changedFileSet(manifestText: string): Set<string> {
  return manifestChangedFiles(parseReviewManifest(manifestText));
}

/** Build every review input from the exact immutable object pair, never the live PR files API. */
export function immutableDiffManifest(workspace: string, baseSha: string, headSha: string): string {
  return generateReviewManifest(workspace, baseSha, headSha);
}

function requireSameHttpsOrigin(value: string, expectedOrigin: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} is not a valid URL`);
  }
  if (
    url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || url.origin !== expectedOrigin
  ) {
    throw new Error(`${label} must use the configured credential-free review service HTTPS origin`);
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
    typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0
    || typeof headSha !== "string" || !SHA.test(headSha)
    || typeof headRef !== "string" || headRef.length < 1 || headRef.length > 256 || /[\u0000-\u001f\u007f]/.test(headRef)
    || typeof baseRef !== "string" || baseRef.length < 1 || baseRef.length > 256 || /[\u0000-\u001f\u007f]/.test(baseRef)
    || pr?.state !== "open" || pr?.draft !== false
    || typeof pr?.title !== "string" || pr.title.length > 20_000 || pr.title.includes("\0")
    || (pr?.body !== null && (typeof pr?.body !== "string" || pr.body.length > 200_000 || pr.body.includes("\0")))
    || !safeRepository(repository)
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
    title: pr.title,
    body: typeof pr.body === "string" ? pr.body : "",
    state: "open",
    draft: false,
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
      [
        "config", "--local", "--name-only", "--get-regexp",
        "^(http(\\..*)?\\.(extraheader|cookiefile|proxy)|credential\\..*|core\\.askpass|include(if\\..*)?\\.path|url\\..*\\.(insteadof|pushinsteadof))$",
      ],
      { cwd: workspace, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status !== 1) throw new Error("could not verify that checkout credentials were removed");
  }
  if (sensitiveConfig.trim()) {
    throw new Error("checkout left an HTTP header or credential helper in .git/config; refusing to start agents");
  }
  let remoteUrls = "";
  try {
    remoteUrls = execFileSync(
      "git",
      ["config", "--local", "--get-regexp", "^remote\\..*\\.(url|pushurl)$"],
      { cwd: workspace, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch (error) {
    if ((error as { status?: number }).status !== 1) throw new Error("could not verify checkout remote URLs");
  }
  for (const line of remoteUrls.split("\n")) {
    const value = line.slice(line.indexOf(" ") + 1).trim();
    if (!value || !value.includes("://")) continue;
    let url: URL;
    try { url = new URL(value); } catch { throw new Error("checkout remote URL is invalid; refusing to start agents"); }
    if (url.username || url.password) throw new Error("checkout remote URL contains persisted credentials; refusing to start agents");
  }
}

const QUIZ_MODES = new Set(["off", "auto", "on"]);

function resolveQuizMode(input: string | undefined, sessionQuiz: unknown): "off" | "auto" | "on" | undefined {
  const explicit = input?.trim().toLowerCase();
  if (explicit && QUIZ_MODES.has(explicit)) return explicit as "off" | "auto" | "on";
  if (explicit) console.log("::warning::smithers review: ignoring invalid quiz input (expected off|auto|on)");
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
  if (!safeRepository(repository)) throw new Error("GITHUB_REPOSITORY is invalid");

  const payload = JSON.parse(decodeUtf8(readStableRegularFile(eventPath, 5 * 1024 * 1024, "GitHub event"), "GitHub event")) as unknown;
  const decision = gateEvent({ eventName, payload });
  if (!decision.run) {
    console.log(`::notice::smithers review skipped: ${safeWorkflowError(decision.reason)}`);
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
  if (liveTarget.state !== "open") {
    console.log("::notice::smithers review skipped: pull request is no longer open");
    return;
  }
  if (liveTarget.draft) {
    console.log("::notice::smithers review skipped: pull request is a draft");
    return;
  }
  if (liveTarget.baseRefName !== "main") {
    console.log("::notice::smithers review skipped: this workflow reviews only pull requests targeting main");
    return;
  }
  if (immutableTarget && liveTarget.headSha !== immutableTarget.headSha) {
    throw new Error(`pull request head moved from ${immutableTarget.headSha} to ${liveTarget.headSha}; refusing stale review`);
  }
  if (immutableTarget && liveTarget.baseRefName !== immutableTarget.baseRefName) {
    throw new Error("pull request base branch changed after the immutable event snapshot");
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

  // Live PR resolution/checkout is the last operation that needs GitHub
  // authority. Remove it before any Git command inspects the untrusted target
  // checkout or any metered service request begins.
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;

  if (!baseWorkspace) throw new Error("SMITHERS_REVIEW_BASE_WORKSPACE is required");
  const baseHead = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: baseWorkspace, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if ((decision.eventName === "pull_request" || decision.eventName === "pull_request_target")
    && decision.baseSha !== baseHead) {
    throw new Error("checked-out base snapshot does not match the immutable event base SHA");
  }
  execFileSync("git", ["fetch", "--no-tags", baseWorkspace, baseHead], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["update-ref", `refs/remotes/origin/${target.baseRefName}`, baseHead], { cwd: workspace, stdio: "ignore" });
  // This is deliberately before OIDC/session creation: the bounded name-status
  // enumeration is the first metered-work gate.
  let manifestText: string;
  try {
    manifestText = immutableDiffManifest(workspace, baseHead, target.headSha);
  } catch (error) {
    if (error instanceof Error && error.message === "immutable review contains no changed files") {
      console.log("::notice::smithers review skipped: pull request contains no changed files");
      return;
    }
    throw error;
  }
  const changedFiles = changedFileSet(manifestText);

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

  const tempRoot = process.env.RUNNER_TEMP?.trim() || tmpdir();
  const sandboxRoot = mkdtempSync(join(tempRoot, "smithers-review-sandbox-"));
  const capturePath = join(sandboxRoot, "captured-review.json");
  const summaryPath = join(sandboxRoot, "summary.json");
  // The review child owns outputDir, so trusted inputs must live in a separate
  // directory that is readable but not writable by the sandbox UID.
  const manifestDir = mkdtempSync(join(tempRoot, "smithers-review-manifest-"));
  chmodSync(manifestDir, 0o755);
  // Replay metadata is an input capability, not child-owned output. Keeping
  // it beside the protected manifest prevents a reviewer from rewriting the
  // PR identity it sees during analysis.
  const fixturePath = join(manifestDir, "github-fixture.json");
  const manifestPath = join(manifestDir, "immutable-diff-manifest.jsonl");
  const artifactPath = join(tempRoot, `smithers-review-artifact-${process.pid}.json`);
  writeProtectedReviewInput(fixturePath, JSON.stringify({
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
      state: "OPEN",
      isDraft: false,
      changed_files: changedFiles.size,
      base: { ref: target.baseRefName, sha: baseHead },
      head: { sha: target.headSha },
    },
  }), 1_000_000);
  process.env.SMITHERS_REVIEW_EXPECTED_BASE_SHA = baseHead;
  writeProtectedReviewManifest(manifestPath, parseReviewManifest(manifestText));
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
  delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;

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
      immutableManifestPath: manifestPath,
    });
  } finally {
    broker.stop();
  }
  if (exitCode !== 0) process.exit(exitCode);

  const summary = readSummary(summaryPath);
  let walkthroughUrl = "";
  const producedWalkthrough = summary?.walkthroughReady === true;
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
    } catch (error) {
      console.log(`::warning::smithers review walkthrough publish failed: ${safeWorkflowError(error, 200)}`);
    }
  }

  let review: unknown;
  try {
    review = JSON.parse(decodeUtf8(readStableRegularFile(capturePath, 1_000_000, "captured review"), "captured review")) as unknown;
  } catch (error) {
    throw new Error(`review finished without a captured PR payload: ${safeWorkflowError(error)}`);
  }
  const reviewObject = obj(review);
  if (walkthroughUrl && typeof reviewObject?.body === "string") {
    const note = `\n\n**Full walkthrough:** ${walkthroughUrl}`;
    const body = reviewObject.body;
    if (body.length + note.length <= 60_000) reviewObject.body = body + note;
  }
  const artifact = serializeValidatedReviewArtifact({
    repository,
    prNumber: decision.prNumber,
    headSha: target.headSha,
    baseSha: baseHead,
    eventName: decision.eventName,
    review,
    changedFiles: [...changedFiles].sort(compareReviewPaths),
    manifestText,
  });
  writeReviewArtifact(artifactPath, artifact);

  const artifactName = `smithers-review-${repository.replace(/[^A-Za-z0-9_.-]+/g, "-")}-${decision.prNumber}-${target.headSha}`;
  setOutput("has-review", "true");
  setOutput("artifact-path", artifactPath);
  setOutput("artifact-name", artifactName);
  console.log(`smithers review: analysis complete for ${repository}#${decision.prNumber}; queued for isolated publication`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`smithers review action: ${safeWorkflowError(error)}`);
    process.exit(1);
  });
}
