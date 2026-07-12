#!/usr/bin/env bun
import { closeSync, constants, fstatSync, openSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gateEvent } from "./gateEvent";
import { canonicalLineIntervals, intervalContains, type LineInterval } from "../../src/github/parsePatchCommentableLines";
import { compareReviewPaths, isSafeReviewPath } from "../../src/reviewManifest";

const MAX_ARTIFACT_BYTES = 1_000_000;
const MAX_GITHUB_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_BODY_CHARS = 60_000;
const MAX_COMMENT_BODY_CHARS = 10_000;
const MAX_COMMENTS = 100;
const GITHUB_REQUEST_DEADLINE_MS = 10_000;
const MAX_GET_RETRIES = 2;
const MAX_REVIEW_PAGES = 30;
const REVIEW_MARKER = "<!-- smithers-review -->";
const SUPERSEDED_PREFIX = "Superseded by a newer smithers review.";
const MAX_UPDATED_REVIEW_BODY = 64_000;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const PUBLICATION_EVENTS = new Set(["pull_request", "pull_request_target", "issue_comment"]);
function safeRepository(value: unknown): value is string {
  return typeof value === "string" && value.length <= 200 && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)
    && value.split("/").every((part) => part.length <= 100 && part !== "." && part !== "..");
}

type Obj = Record<string, unknown>;

function obj(value: unknown): Obj | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Obj : null;
}

function exactKeys(value: Obj, allowed: string[]): boolean {
  const set = new Set(allowed);
  return Object.keys(value).length === set.size && Object.keys(value).every((key) => set.has(key));
}
function keysWithin(value: Obj, allowed: string[]): boolean {
  const set = new Set(allowed);
  return Object.keys(value).every((key) => set.has(key));
}

function cleanText(value: string): string {
  // Never let an untrusted model artifact generate user/team mention spam.
  return value.replace(/@(?!\u200b)/g, "@\u200b");
}

function canonicalText(value: string): string {
  const cleaned = cleanText(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, " ");
  return utf16Prefix(cleaned, Number.MAX_SAFE_INTEGER);
}

function normalizedText(value: unknown): string | null {
  if (typeof value !== "string" || value.includes("\0")) return null;
  return canonicalText(value);
}

export function reviewPathLabel(value: string): string {
  return cleanText(value)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/`/g, "'");
}

export interface ValidatedReviewPayload {
  commit_id: string;
  event: "COMMENT";
  body: string;
  comments: Array<{
    path: string;
    line: number;
    side: "RIGHT";
    start_line?: number;
    start_side?: "RIGHT";
    body: string;
  }>;
}

export type ReviewLineCapabilities = ReadonlyMap<string, ReadonlySet<number>>;

export function validateReviewPayload(
  value: unknown,
  expectedHeadSha: string,
  changedFiles: Set<string>,
  commentableLines?: ReviewLineCapabilities,
): ValidatedReviewPayload {
  const review = obj(value);
  if (!review || !exactKeys(review, ["commit_id", "event", "body", "comments"])) {
    throw new Error("review payload has an invalid top-level schema");
  }
  if (review.commit_id !== expectedHeadSha || !SHA.test(expectedHeadSha)) {
    throw new Error("review commit_id does not match the immutable PR head");
  }
  if (review.event !== "COMMENT") throw new Error("review event must be COMMENT");
  const body = normalizedText(review.body);
  if (
    body === null || body.includes("\0") || body.length === 0 || body.length > MAX_BODY_CHARS
    || !body.startsWith("<!-- smithers-review -->")
  ) throw new Error("review body is missing its marker, oversized, or contains control bytes");
  if (!Array.isArray(review.comments) || review.comments.length > MAX_COMMENTS) {
    throw new Error("review comments must be an array of at most 100 entries");
  }
  const intervalCache = new Map<string, readonly LineInterval[]>();

  const comments: ValidatedReviewPayload["comments"] = review.comments.map((entry, index) => {
    const comment = obj(entry);
    if (!comment || !keysWithin(comment, ["path", "line", "side", "start_line", "start_side", "body"])) {
      throw new Error(`review comment ${index} has an invalid schema`);
    }
    // Repository paths are capabilities, not display text. Keep them exact;
    // sanitizing before lookup would make the authorization boundary lossy.
    const path = typeof comment.path === "string" ? comment.path : null;
    const commentBody = normalizedText(comment.body);
    if (
      path === null || path.length === 0 || path.length > 1024
      || path.startsWith("/") || path.includes("\0") || !changedFiles.has(path)
    ) throw new Error(`review comment ${index} does not target a changed file`);
    if (!Number.isSafeInteger(comment.line) || (comment.line as number) <= 0) {
      throw new Error(`review comment ${index} has an invalid line`);
    }
    if (comment.side !== "RIGHT") throw new Error(`review comment ${index} must use RIGHT side`);
    if (
      commentBody === null || commentBody.includes("\0") || commentBody.length === 0
      || commentBody.length > MAX_COMMENT_BODY_CHARS
    ) throw new Error(`review comment ${index} has an invalid body`);
    const startLine = comment.start_line;
    if (startLine !== undefined && (
      !Number.isSafeInteger(startLine) || (startLine as number) <= 0 || (startLine as number) > (comment.line as number)
    )) throw new Error(`review comment ${index} has an invalid start_line`);
    if (startLine !== undefined && comment.start_side !== "RIGHT") {
      throw new Error(`review comment ${index} with start_line must use RIGHT start_side`);
    }
    if (startLine === undefined && comment.start_side !== undefined) {
      throw new Error(`review comment ${index} has start_side without start_line`);
    }
    if (commentableLines) {
      const lines = commentableLines.get(path);
      const end = comment.line as number;
      const start = startLine === undefined ? end : startLine as number;
      if (!lines?.has(start) || !lines.has(end)) {
        throw new Error(`review comment ${index} is outside the immutable patch capability`);
      }
      let intervals = intervalCache.get(path);
      if (!intervals) {
        intervals = canonicalLineIntervals(lines);
        intervalCache.set(path, intervals);
      }
      // One linear pass builds canonical intervals per referenced file; each
      // comment then checks its full range in logarithmic time without looping
      // across attacker-selected line numbers or rescanning a multi-MB patch.
      if (!intervalContains(intervals, start, end)) {
        throw new Error(`review comment ${index} range crosses an immutable patch gap`);
      }
    }
    return {
      path,
      line: comment.line as number,
      side: "RIGHT",
      ...(startLine === undefined ? {} : { start_line: startLine as number, start_side: "RIGHT" as const }),
      body: commentBody,
    };
  });

  return {
    commit_id: expectedHeadSha,
    event: "COMMENT",
    body,
    comments,
  };
}

function githubEndpoint(path: string): URL {
  const api = process.env.GITHUB_API_URL ?? "https://api.github.com";
  const base = new URL(api);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
    throw new Error("GITHUB_API_URL must be a credential-free HTTPS base URL");
  }
  const endpoint = new URL(path.replace(/^\//, ""), `${base.toString().replace(/\/$/, "")}/`);
  if (endpoint.origin !== base.origin) throw new Error("GitHub endpoint escaped the configured API origin");
  return endpoint;
}

function githubHeaders(token: string, contentType = false): Record<string, string> {
  if (token.length < 1 || token.length > 8_192 || /[^\x21-\x7e]/.test(token)) throw new Error("GitHub token is invalid");
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
    ...(contentType ? { "content-type": "application/json" } : {}),
  };
}

function boundedGithubText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/@(?!\u200b)/g, "@\u200b").slice(0, 240);
}

function safeGithubError(prefix: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`${prefix}: ${boundedGithubText(detail)}`);
}

/** Take at most `limit` UTF-16 code units without splitting a surrogate pair.
 * Lone surrogates are normalised so JSON/fetch implementations cannot disagree
 * about the byte representation of an error or folded review. */
function utf16Prefix(value: string, limit: number): string {
  let result = "";
  for (let i = 0; i < value.length && result.length < limit;) {
    const code = value.charCodeAt(i);
    const paired = code >= 0xd800 && code <= 0xdbff && i + 1 < value.length
      && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff;
    const unit = paired ? value.slice(i, i + 2) : (code >= 0xd800 && code <= 0xdfff ? "\ufffd" : value[i]);
    if (result.length + unit.length > limit) break;
    result += unit;
    i += paired ? 2 : 1;
  }
  return result;
}

function githubRequestId(response: Response): string {
  return boundedGithubText(response.headers.get("x-github-request-id") ?? "unknown");
}

type GithubFetch = typeof fetch;

function abortable<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("GitHub request deadline exceeded"));
  }
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason instanceof Error ? signal.reason : new Error("GitHub request deadline exceeded"));
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve(promise).then(
      (value) => { signal.removeEventListener("abort", aborted); resolve(value); },
      (error) => { signal.removeEventListener("abort", aborted); reject(error); },
    );
  });
}

async function readBoundedResponse(response: Response, signal?: AbortSignal): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      const next = signal ? await abortable(reader.read(), signal) : await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_GITHUB_RESPONSE_BYTES) throw new Error("GitHub response is oversized");
      chunks.push(next.value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw safeGithubError("GitHub response read failed", error);
  } finally {
    signal?.removeEventListener("abort", cancel);
    try { reader.releaseLock(); } catch { /* a hostile adapter may retain a pending read */ }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw safeGithubError("GitHub response decode failed", error);
  }
}

function boundedResponse(response: Response, body: string): Response {
  return new Response(body, { status: response.status, headers: response.headers });
}

async function githubGet(path: string, token: string, fetchImpl: GithubFetch = fetch): Promise<Response> {
  const endpoint = githubEndpoint(path);
  const headers = githubHeaders(token);
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_GET_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("GitHub GET deadline exceeded")), GITHUB_REQUEST_DEADLINE_MS);
    let retryTransport = false;
    try {
      let response: Response;
      try {
        response = await abortable(
          fetchImpl(endpoint, { redirect: "error", headers, signal: controller.signal }),
          controller.signal,
        );
      } catch (error) {
        // A fetch rejection is the only retryable condition. Decode, JSON and
        // HTTP failures are observations about this exact guarded read.
        lastError = safeGithubError("GitHub GET transport failed", error);
        if (attempt === MAX_GET_RETRIES) throw lastError;
        retryTransport = true;
        response = undefined as never;
      }
      if (!retryTransport) {
        // Keep the deadline active while the body is consumed. Returning the
        // original Response would leave response.json() outside the timeout.
        const replay = boundedResponse(response, await readBoundedResponse(response, controller.signal));
        // HTTP responses are authoritative PR state, not transport failures:
        // retrying one could turn a guarded publication into a stale write.
        return replay;
      }
    } catch (error) {
      throw error instanceof Error ? error : safeGithubError("GitHub GET failed", error);
    }
    finally { clearTimeout(timer); }
    if (retryTransport) await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
  }
  throw lastError instanceof Error ? lastError : new Error("GitHub GET failed");
}

async function postValidatedReview(
  path: string,
  token: string,
  payload: ValidatedReviewPayload,
  fetchImpl: GithubFetch = fetch,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("GitHub POST deadline exceeded")), GITHUB_REQUEST_DEADLINE_MS);
  try {
    try {
      const response = await abortable(fetchImpl(githubEndpoint(path), {
        method: "POST",
        redirect: "error",
        headers: githubHeaders(token, true),
        body: JSON.stringify(payload),
        signal: controller.signal,
      }), controller.signal);
      return boundedResponse(response, await readBoundedResponse(response, controller.signal));
    } catch (error) {
      // POSTs are deliberately never retried, but their transport failures are
      // still untrusted text and must not be allowed into workflow logs.
      throw safeGithubError("GitHub POST transport failed", error);
    }
  } finally { clearTimeout(timer); }
}

async function putReviewBody(
  path: string,
  token: string,
  body: string,
  fetchImpl: GithubFetch = fetch,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("GitHub PUT deadline exceeded")), GITHUB_REQUEST_DEADLINE_MS);
  try {
    try {
      const response = await abortable(fetchImpl(githubEndpoint(path), {
        method: "PUT",
        redirect: "error",
        headers: githubHeaders(token, true),
        body: JSON.stringify({ body }),
        signal: controller.signal,
      }), controller.signal);
      return boundedResponse(response, await readBoundedResponse(response, controller.signal));
    } catch (error) {
      throw safeGithubError("GitHub PUT transport failed", error);
    }
  } finally { clearTimeout(timer); }
}

async function parseGithubJson(response: Response, label: string): Promise<unknown> {
  try {
    return JSON.parse(await response.text());
  } catch (error) {
    throw safeGithubError(`GitHub ${label} JSON failed`, error);
  }
}

async function currentPullRequest(repository: string, prNumber: number, token: string): Promise<Obj> {
  const response = await githubGet(`/repos/${repository}/pulls/${prNumber}`, token);
  if (!response.ok) throw new Error(`could not resolve PR head: GitHub HTTP ${response.status} request=${githubRequestId(response)}`);
  const value = obj(await parseGithubJson(response, "pull request"));
  if (!value) throw new Error("GitHub returned an invalid pull request payload");
  return value;
}

export async function publishReviewCore(input: {
  repository: string;
  prNumber: number;
  token: string;
  expectedHead: string;
  expectedBase: string;
  expectedCount: number;
  payload: ValidatedReviewPayload;
  fetchImpl?: GithubFetch;
}): Promise<{ folded: boolean; reviewId?: number; reviewUrl?: string; superseded: number }> {
  if (!safeRepository(input.repository)
    || !Number.isSafeInteger(input.prNumber) || input.prNumber < 1
    || !SHA.test(input.expectedHead) || !SHA.test(input.expectedBase)
    || !Number.isSafeInteger(input.expectedCount) || input.expectedCount < 1 || input.expectedCount > 3_000) {
    throw new Error("review publication binding is invalid");
  }
  const transport = input.fetchImpl ?? fetch;
  const latest = obj(await (async () => {
    const response = await githubGet(`/repos/${input.repository}/pulls/${input.prNumber}`, input.token, transport);
    if (!response.ok) throw new Error(`could not resolve PR head: GitHub HTTP ${response.status} request=${githubRequestId(response)}`);
    const value = obj(await parseGithubJson(response, "pull request"));
    if (!value) throw new Error("GitHub returned an invalid pull request payload");
    return value;
  })());
  if (!latest) throw new Error("GitHub returned an invalid pull request payload");
  assertPublishablePullRequest(latest, input.expectedHead, input.expectedBase, input.expectedCount);
  let foldedFallback = false;
  let response = await postValidatedReview(`/repos/${input.repository}/pulls/${input.prNumber}/reviews`, input.token, input.payload, transport);
  if (response.status === 422 && input.payload.comments.length > 0) {
    foldedFallback = true;
    const folded = foldCommentsWithStats(input.payload);
    const fallbackPayload = folded.payload;
    const omitted = folded.omitted;
    console.log(`smithers-review-telemetry type=inline_422_fallback retained=${folded.retained} omitted=${omitted}`);
    const guarded = obj(await (async () => {
      const retry = await githubGet(`/repos/${input.repository}/pulls/${input.prNumber}`, input.token, transport);
      if (!retry.ok) throw new Error(`could not resolve PR head: GitHub HTTP ${retry.status} request=${githubRequestId(retry)}`);
      return await parseGithubJson(retry, "pull request");
    })());
    if (!guarded) throw new Error("GitHub returned an invalid pull request payload");
    assertPublishablePullRequest(guarded, input.expectedHead, input.expectedBase, input.expectedCount);
    response = await postValidatedReview(`/repos/${input.repository}/pulls/${input.prNumber}/reviews`, input.token, fallbackPayload, transport);
  }
  if (!response.ok) {
    const detail = boundedGithubText(await readBoundedResponse(response));
    throw new Error(`GitHub rejected the review: HTTP ${response.status} request=${githubRequestId(response)} detail=${detail}`);
  }
  // The POST is already durable at this point. Treat a malformed success body
  // as missing optional lifecycle metadata instead of turning a successful
  // write into a retryable failure that could duplicate the review.
  let created: Obj | null = null;
  try { created = obj(JSON.parse(await response.text())); } catch { /* lifecycle metadata unavailable */ }
  const reviewId = Number.isSafeInteger(created?.id) && (created?.id as number) > 0 ? created!.id as number : undefined;
  const author = obj(created?.user)?.login;
  let reviewUrl: string | undefined;
  if (typeof created?.html_url === "string" && created.html_url.length <= 2_048) {
    try {
      const candidate = new URL(created.html_url);
      if (candidate.protocol === "https:" && !candidate.username && !candidate.password) reviewUrl = candidate.toString();
    } catch { /* optional display metadata is invalid */ }
  }
  let superseded = 0;
  if (reviewId !== undefined && typeof author === "string" && /^[A-Za-z0-9-]{1,100}$/.test(author)) {
    try {
      superseded = await supersedeEarlierPublishedReviews({
        repository: input.repository,
        prNumber: input.prNumber,
        token: input.token,
        currentReviewId: reviewId,
        author,
        fetchImpl: transport,
      });
    } catch (error) {
      console.error(`smithers-review: supersede check failed (non-fatal): ${boundedGithubText(error instanceof Error ? error.message : String(error))}`);
    }
  }
  return {
    folded: foldedFallback,
    ...(reviewId === undefined ? {} : { reviewId }),
    ...(reviewUrl === undefined ? {} : { reviewUrl }),
    superseded,
  };
}

async function supersedeEarlierPublishedReviews(input: {
  repository: string;
  prNumber: number;
  token: string;
  currentReviewId: number;
  author: string;
  fetchImpl: GithubFetch;
}): Promise<number> {
  let superseded = 0;
  for (let page = 1; page <= MAX_REVIEW_PAGES; page += 1) {
    const response = await githubGet(
      `/repos/${input.repository}/pulls/${input.prNumber}/reviews?per_page=100&page=${page}`,
      input.token,
      input.fetchImpl,
    );
    if (!response.ok) throw new Error(`could not list prior reviews: GitHub HTTP ${response.status} request=${githubRequestId(response)}`);
    const reviews = await parseGithubJson(response, "review list");
    if (!Array.isArray(reviews) || reviews.length > 100) throw new Error("GitHub returned an invalid review list");
    for (const raw of reviews) {
      const review = obj(raw);
      const id = review?.id;
      const body = review?.body;
      const login = obj(review?.user)?.login;
      // Review IDs give concurrent publishers a total order. An older run may
      // finish this scan after a newer run posts, but it can never supersede a
      // review whose ID is at least its own.
      if (!Number.isSafeInteger(id) || (id as number) <= 0 || (id as number) >= input.currentReviewId
        || login !== input.author || typeof body !== "string"
        || !body.startsWith(REVIEW_MARKER) || body.startsWith(SUPERSEDED_PREFIX)) continue;
      const updated = utf16Prefix(`${SUPERSEDED_PREFIX}\n\n${body}`, MAX_UPDATED_REVIEW_BODY);
      try {
        const result = await putReviewBody(
          `/repos/${input.repository}/pulls/${input.prNumber}/reviews/${id}`,
          input.token,
          updated,
          input.fetchImpl,
        );
        if (!result.ok) {
          console.error(`smithers-review: could not mark prior review ${id} superseded: GitHub HTTP ${result.status} request=${githubRequestId(result)}`);
          continue;
        }
        superseded += 1;
      } catch (error) {
        console.error(`smithers-review: could not mark prior review ${id} superseded: ${boundedGithubText(error instanceof Error ? error.message : String(error))}`);
      }
    }
    if (reviews.length < 100) return superseded;
  }
  console.error(`smithers-review: supersede scan stopped at the ${MAX_REVIEW_PAGES * 100}-review safety boundary`);
  return superseded;
}

export function currentHeadSha(value: unknown): string {
  const sha = obj(obj(value)?.head)?.sha;
  if (typeof sha !== "string" || !SHA.test(sha)) throw new Error("current PR head is invalid");
  return sha;
}

export function currentBaseSha(value: unknown): string {
  const sha = obj(obj(value)?.base)?.sha;
  if (typeof sha !== "string" || !SHA.test(sha)) throw new Error("current PR base is invalid");
  return sha;
}

export function assertCurrentHead(value: unknown, expectedHead: string): void {
  if (currentHeadSha(value) !== expectedHead) {
    throw new Error("pull request head changed before publication");
  }
}

export function assertCurrentBase(value: unknown, expectedBase: string): void {
  if (currentBaseSha(value) !== expectedBase) {
    throw new Error("pull request base changed before publication");
  }
}

export function assertMainBase(value: unknown): void {
  const ref = obj(obj(value)?.base)?.ref;
  if (ref !== "main") throw new Error("pull request no longer targets main");
}

export function assertChangedFileCount(value: unknown): void {
  const count = obj(value)?.changed_files;
  if (!Number.isSafeInteger(count) || (count as number) < 1 || (count as number) > 3_000) {
    throw new Error("pull request exceeds GitHub's 3,000-file review boundary");
  }
}

export function assertPublishablePullRequest(value: unknown, expectedHead: string, expectedBase: string, expectedCount?: number): void {
  const pr = obj(value);
  if (pr?.state !== "open") throw new Error("pull request is no longer open");
  if (pr?.draft !== false) throw new Error("pull request draft state is invalid");
  assertChangedFileCount(value);
  if (expectedCount !== undefined && obj(value)?.changed_files !== expectedCount) throw new Error("pull request changed-file count does not match immutable artifact");
  assertMainBase(value);
  assertCurrentHead(value, expectedHead);
  assertCurrentBase(value, expectedBase);
}

interface ReviewArtifactEnvelope {
  schemaVersion: 2;
  repository: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  eventName: string;
  changedFiles: string[];
  review: unknown;
}

export interface ParsedReviewArtifact extends Omit<ReviewArtifactEnvelope, "review"> {
  review: ValidatedReviewPayload;
}

/** Parse the scalar envelope so it can be bound to the trusted event. */
export function parseReviewArtifactEnvelope(value: unknown): ReviewArtifactEnvelope {
  const artifact = obj(value);
  const keys = ["schemaVersion", "repository", "prNumber", "headSha", "baseSha", "eventName", "changedFiles", "review"];
  if (!artifact || artifact.schemaVersion !== 2 || Object.keys(artifact).length !== keys.length || !exactKeys(artifact, keys)) {
    throw new Error("review artifact envelope has an invalid schema");
  }
  if (
    !safeRepository(artifact.repository)
    || typeof artifact.prNumber !== "number" || !Number.isSafeInteger(artifact.prNumber) || artifact.prNumber <= 0
    || typeof artifact.headSha !== "string" || !SHA.test(artifact.headSha)
    || typeof artifact.baseSha !== "string" || !SHA.test(artifact.baseSha)
    || typeof artifact.eventName !== "string" || !PUBLICATION_EVENTS.has(artifact.eventName)
    || !Array.isArray(artifact.changedFiles)
    || artifact.changedFiles.length < 1 || artifact.changedFiles.length > 3_000
    || new Set(artifact.changedFiles).size !== artifact.changedFiles.length
    || artifact.changedFiles.some((file, index, all) => !isSafeReviewPath(file) || (index > 0 && compareReviewPaths(all[index - 1] as string, file) >= 0))
  ) throw new Error("review artifact envelope has an invalid binding");
  return {
    schemaVersion: 2,
    repository: artifact.repository,
    prNumber: artifact.prNumber,
    headSha: artifact.headSha,
    baseSha: artifact.baseSha,
    eventName: artifact.eventName,
    changedFiles: artifact.changedFiles,
    review: artifact.review,
  };
}

/** Declassify artifact content only after its review is fully validated. */
export function parseValidatedReviewArtifact(value: unknown): ParsedReviewArtifact {
  const envelope = parseReviewArtifactEnvelope(value);
  const artifactFiles = new Set(envelope.changedFiles);
  if (artifactFiles.size !== envelope.changedFiles.length) {
    throw new Error("review artifact changed-file capability does not match immutable analysis");
  }
  const parsed = {
    ...envelope,
    review: validateReviewPayload(envelope.review, envelope.headSha, artifactFiles),
  };
  return deepFreeze(parsed);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function readBoundedJsonFile(path: string, maxBytes: number, label: string): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size < 1 || before.size > maxBytes) throw new Error(`${label} is empty, oversized, or not regular`);
    const contents = readFileSync(fd);
    const after = fstatSync(fd);
    if (contents.byteLength !== before.size || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino || after.dev !== before.dev) {
      throw new Error(`${label} changed while it was being read`);
    }
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(contents); }
    catch { throw new Error(`${label} is not valid UTF-8`); }
    try { return JSON.parse(text) as unknown; }
    catch { throw new Error(`${label} is not valid JSON`); }
  } finally { closeSync(fd); }
}

export function readReviewArtifact(directory: string): unknown {
  const candidates = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => join(directory, entry.name));
  if (candidates.length !== 1) throw new Error("publisher expected exactly one JSON artifact file");
  const fd = openSync(candidates[0], constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) throw new Error("review artifact is not a regular file");
    if (before.size === 0 || before.size > MAX_ARTIFACT_BYTES) throw new Error("review artifact is empty or exceeds 1 MB");
    // Reuse the already-open descriptor's stable read while retaining the
    // directory's exactly-one-JSON selection above.
    const contents = readFileSync(fd);
    const after = fstatSync(fd);
    if (contents.byteLength !== before.size || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino || after.dev !== before.dev) {
      throw new Error("review artifact changed while it was being read");
    }
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(contents); }
    catch { throw new Error("review artifact is not valid UTF-8"); }
    try { return JSON.parse(text) as unknown; }
    catch { throw new Error("review artifact is not valid JSON"); }
  } finally {
    closeSync(fd);
  }
}

function foldCommentsWithStats(payload: ValidatedReviewPayload): { payload: ValidatedReviewPayload; omitted: number; retained: number } {
  const marker = (count: number) => `\n\n[${count} inline finding${count === 1 ? "" : "s"} omitted due to review size limits]`;
  const heading = "\n\n### Inline findings\n";
  const truncation = "\n\n[review body truncated to fit the publication limit]";
  // Fold defensively even when this helper is called directly by a CLI
  // adapter: control characters, mentions and lone surrogates must be stable
  // before UTF-16 budgeting begins.
  const safeText = canonicalText;
  const entries = payload.comments.map((comment) => `\n- \`${reviewPathLabel(comment.path)}:${comment.start_line ?? comment.line}\`\n\n${safeText(comment.body)}\n`);
  if (entries.length === 0) return { payload, omitted: 0, retained: 0 };
  let source = safeText(payload.body);
  const completeBody = `${source}${heading}${entries.join("")}`;
  if (completeBody.length <= MAX_BODY_CHARS) {
    return { payload: { ...payload, body: completeBody, comments: [] }, omitted: 0, retained: entries.length };
  }
  // Reserve a marker for every finding before choosing a safe source prefix.
  // The marker is recalculated for each candidate below, including 9/10 and
  // 99/100 digit transitions.
  const worstMarker = marker(entries.length);
  const sourceBudget = MAX_BODY_CHARS - heading.length - worstMarker.length;
  if (source.length > sourceBudget) {
    const room = Math.max(0, sourceBudget - truncation.length);
    let prefix = utf16Prefix(source, room);
    // Never leave a neutralised mention half-written at the boundary.
    if (prefix.endsWith("@") && source[prefix.length] === "\u200b") prefix = prefix.slice(0, -1);
    source = `${prefix}${truncation}`;
    source = utf16Prefix(source, sourceBudget);
  }
  let body = `${source}${heading}`;
  const retained: string[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const candidate = body + entries[i];
    // Reserve the exact suffix for the worst case remaining omission count.
    // This keeps the accounting truthful at 9/10/99/100 boundaries.
    const omittedIfKept = entries.length - retained.length - 1;
    const suffix = omittedIfKept > 0 ? marker(omittedIfKept) : "";
    if (candidate.length + suffix.length <= MAX_BODY_CHARS) {
      body = candidate;
      retained.push(entries[i]);
    }
  }
  const omitted = entries.length - retained.length;
  if (omitted > 0) body += marker(omitted);
  if (body.length > MAX_BODY_CHARS) throw new Error("folded review could not fit reserved markers");
  return { payload: { ...payload, body, comments: [] }, omitted, retained: retained.length };
}

export function foldComments(payload: ValidatedReviewPayload): ValidatedReviewPayload {
  return foldCommentsWithStats(payload).payload;
}

export async function publishReviewMain(): Promise<void> {
  const token = process.env.GH_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const directory = process.env.SMITHERS_REVIEW_ARTIFACT_DIR;
  if (!token || !repository || !eventPath || !directory) throw new Error("publisher environment is incomplete");
  if (!safeRepository(repository)) {
    throw new Error("GITHUB_REPOSITORY is invalid");
  }

  const event = obj(readBoundedJsonFile(eventPath, 5 * 1024 * 1024, "publication event"));
  const rawArtifact = readReviewArtifact(directory);
  const artifact = parseValidatedReviewArtifact(rawArtifact);
  if (!event) throw new Error("publication event has an invalid schema");

  const eventName = process.env.GITHUB_EVENT_NAME ?? "";
  const gate = gateEvent({ eventName, payload: event });
  if (!gate.run) throw new Error(`publication event failed policy gate: ${gate.reason}`);
  if (artifact.repository !== repository || artifact.eventName !== eventName
    || gate.prNumber !== artifact.prNumber) {
    throw new Error("artifact repository/event/PR binding does not match the immutable publication event");
  }
  let prNumber: number;
  let expectedHead: string;
  let expectedBase: string;
  if (eventName === "pull_request" || eventName === "pull_request_target") {
    const pr = obj(event.pull_request);
    const head = obj(pr?.head);
    const base = obj(pr?.base);
    const headRepo = obj(head?.repo);
    const baseRepo = obj(base?.repo);
    const eventRepo = obj(event.repository);
    if (
      typeof pr?.number !== "number" || !Number.isSafeInteger(pr.number) || pr.number <= 0
      || typeof head?.sha !== "string" || !SHA.test(head.sha)
      || typeof base?.sha !== "string" || !SHA.test(base.sha)
      || typeof eventRepo?.id !== "number" || eventRepo.full_name !== repository
      || typeof baseRepo?.id !== "number" || baseRepo.id !== eventRepo.id || baseRepo.full_name !== repository
      || base?.ref !== "main"
      || typeof headRepo?.id !== "number" || typeof headRepo.full_name !== "string"
      || (eventName === "pull_request" && (headRepo.id !== eventRepo.id || headRepo.full_name !== repository))
    ) throw new Error("publisher refuses malformed or unprivileged pull request event");
    if (pr.number !== artifact.prNumber) throw new Error("artifact PR binding does not match the pull request event");
    prNumber = artifact.prNumber;
    expectedHead = head.sha;
    expectedBase = base.sha;
  } else if (eventName === "issue_comment") {
    const issue = obj(event.issue);
    if (typeof issue?.number !== "number" || !Number.isSafeInteger(issue.number) || issue.number <= 0) {
      throw new Error("issue_comment event is missing PR number");
    }
    if (issue.number !== artifact.prNumber) throw new Error("artifact PR binding does not match the issue comment event");
    prNumber = artifact.prNumber;
    const current = await currentPullRequest(repository, prNumber, token);
    assertMainBase(current);
    expectedHead = currentHeadSha(current);
    expectedBase = currentBaseSha(current);
  } else {
    throw new Error(`publisher does not support ${eventName || "missing event"}`);
  }

  if (
    artifact.headSha !== expectedHead || artifact.baseSha !== expectedBase
  ) {
    throw new Error("artifact repository/PR/head/base binding does not match the immutable publication event");
  }
  const artifactFiles = new Set(artifact.changedFiles);
  const payload = artifact.review;
  // Recheck immediately before the write. A synchronize event may supersede
  // this run while artifact validation/file pagination is in progress.
  await publishReviewCore({ repository, prNumber, token, expectedHead, expectedBase, expectedCount: artifactFiles.size, payload });
  console.log(`smithers review: published isolated review to ${repository}#${prNumber}`);
}

if (import.meta.main) {
  publishReviewMain().catch((error) => {
    console.error(`smithers review publisher: ${boundedGithubText(error instanceof Error ? error.message : String(error))}`);
    process.exit(1);
  });
}
