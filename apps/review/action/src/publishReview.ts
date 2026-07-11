#!/usr/bin/env bun
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gateEvent } from "./gateEvent";

const MAX_ARTIFACT_BYTES = 1_000_000;
const MAX_BODY_CHARS = 60_000;
const MAX_COMMENT_BODY_CHARS = 10_000;
const MAX_COMMENTS = 100;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

type Obj = Record<string, unknown>;

function obj(value: unknown): Obj | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Obj : null;
}

function exactKeys(value: Obj, allowed: string[]): boolean {
  const set = new Set(allowed);
  return Object.keys(value).every((key) => set.has(key));
}

function cleanText(value: string): string {
  // Never let an untrusted model artifact generate user/team mention spam.
  return value.replace(/@/g, "@\u200b");
}

export function reviewPathLabel(value: string): string {
  return cleanText(value)
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ")
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

export function validateReviewPayload(
  value: unknown,
  expectedHeadSha: string,
  changedFiles: Set<string>,
): ValidatedReviewPayload {
  const review = obj(value);
  if (!review || !exactKeys(review, ["commit_id", "event", "body", "comments"])) {
    throw new Error("review payload has an invalid top-level schema");
  }
  if (review.commit_id !== expectedHeadSha || !SHA.test(expectedHeadSha)) {
    throw new Error("review commit_id does not match the immutable PR head");
  }
  if (review.event !== "COMMENT") throw new Error("review event must be COMMENT");
  if (
    typeof review.body !== "string" || review.body.length === 0 || review.body.length > MAX_BODY_CHARS
    || !review.body.startsWith("<!-- smithers-review -->")
    || /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(review.body)
  ) throw new Error("review body is missing its marker, oversized, or contains control bytes");
  if (!Array.isArray(review.comments) || review.comments.length > MAX_COMMENTS) {
    throw new Error("review comments must be an array of at most 100 entries");
  }

  const comments: ValidatedReviewPayload["comments"] = review.comments.map((entry, index) => {
    const comment = obj(entry);
    if (!comment || !exactKeys(comment, ["path", "line", "side", "start_line", "start_side", "body"])) {
      throw new Error(`review comment ${index} has an invalid schema`);
    }
    if (
      typeof comment.path !== "string" || comment.path.length === 0 || comment.path.length > 1024
      || comment.path.startsWith("/") || comment.path.includes("\0") || !changedFiles.has(comment.path)
    ) throw new Error(`review comment ${index} does not target a changed file`);
    if (!Number.isSafeInteger(comment.line) || (comment.line as number) <= 0) {
      throw new Error(`review comment ${index} has an invalid line`);
    }
    if (comment.side !== "RIGHT") throw new Error(`review comment ${index} must use RIGHT side`);
    if (
      typeof comment.body !== "string" || comment.body.length === 0
      || comment.body.length > MAX_COMMENT_BODY_CHARS
      || /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(comment.body)
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
    return {
      path: comment.path,
      line: comment.line as number,
      side: "RIGHT",
      ...(startLine === undefined ? {} : { start_line: startLine as number, start_side: "RIGHT" as const }),
      body: cleanText(comment.body),
    };
  });

  return {
    commit_id: expectedHeadSha,
    event: "COMMENT",
    body: cleanText(review.body),
    comments,
  };
}

async function githubJson(path: string, token: string, init: RequestInit = {}): Promise<Response> {
  const api = process.env.GITHUB_API_URL ?? "https://api.github.com";
  const base = new URL(api);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
    throw new Error("GITHUB_API_URL must be a credential-free HTTPS base URL");
  }
  const endpoint = new URL(path.replace(/^\//, ""), `${base.toString().replace(/\/$/, "")}/`);
  if (endpoint.origin !== base.origin) throw new Error("GitHub endpoint escaped the configured API origin");
  // This publisher intentionally sends one schema/binding/size-validated
  // review artifact to the immutable GitHub PR endpoint. Redirects are denied.
  // codeql[js/file-access-to-http]
  const response = await fetch(endpoint, {
    ...init,
    redirect: "error",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
  return response;
}

async function currentPullRequest(repository: string, prNumber: number, token: string): Promise<Obj> {
  const response = await githubJson(`/repos/${repository}/pulls/${prNumber}`, token);
  if (!response.ok) throw new Error(`could not resolve PR head: GitHub HTTP ${response.status}`);
  const value = obj(await response.json());
  if (!value) throw new Error("GitHub returned an invalid pull request payload");
  return value;
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

async function changedFileNames(repository: string, prNumber: number, token: string): Promise<Set<string>> {
  const files = new Set<string>();
  for (let page = 1; page <= 30; page += 1) {
    const response = await githubJson(`/repos/${repository}/pulls/${prNumber}/files?per_page=100&page=${page}`, token);
    if (!response.ok) throw new Error(`could not validate changed files: GitHub HTTP ${response.status}`);
    const records = await response.json() as unknown;
    if (!Array.isArray(records)) throw new Error("GitHub returned an invalid files payload");
    for (const record of records) {
      const filename = obj(record)?.filename;
      if (typeof filename === "string" && filename.length > 0) files.add(filename);
    }
    if (records.length < 100) return files;
  }
  throw new Error("pull request exceeds GitHub's 3,000-file review boundary");
}

function artifactFile(directory: string): string {
  const candidates = readdirSync(directory)
    .map((name) => join(directory, name))
    .filter((path) => lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink() && path.endsWith(".json"));
  if (candidates.length !== 1) throw new Error("publisher expected exactly one JSON artifact file");
  if (lstatSync(candidates[0]).size > MAX_ARTIFACT_BYTES) throw new Error("review artifact exceeds 1 MB");
  return candidates[0];
}

function foldComments(payload: ValidatedReviewPayload): ValidatedReviewPayload {
  let body = `${payload.body}\n\n### Inline findings\n`;
  for (const comment of payload.comments) {
    const entry = `\n- \`${reviewPathLabel(comment.path)}:${comment.start_line ?? comment.line}\`\n\n${comment.body}\n`;
    if (body.length + entry.length > MAX_BODY_CHARS - 100) break;
    body += entry;
  }
  return { ...payload, body, comments: [] };
}

async function main(): Promise<void> {
  const token = process.env.GH_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const directory = process.env.SMITHERS_REVIEW_ARTIFACT_DIR;
  if (!token || !repository || !eventPath || !directory) throw new Error("publisher environment is incomplete");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("GITHUB_REPOSITORY is invalid");
  }

  const event = obj(JSON.parse(readFileSync(eventPath, "utf8")));
  const artifact = obj(JSON.parse(readFileSync(artifactFile(directory), "utf8")));
  if (!event || !artifact || artifact.schemaVersion !== 1 || !exactKeys(artifact, [
    "schemaVersion", "repository", "prNumber", "headSha", "baseSha", "eventName", "review", "summary",
  ])) throw new Error("review artifact envelope has an invalid schema");

  const eventName = process.env.GITHUB_EVENT_NAME ?? "";
  const gate = gateEvent({ eventName, payload: event });
  if (!gate.run) throw new Error(`publication event failed policy gate: ${gate.reason}`);
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
    prNumber = pr.number;
    expectedHead = head.sha;
    expectedBase = base.sha;
  } else if (eventName === "issue_comment") {
    const issue = obj(event.issue);
    if (typeof issue?.number !== "number" || !Number.isSafeInteger(issue.number) || issue.number <= 0) {
      throw new Error("issue_comment event is missing PR number");
    }
    prNumber = issue.number;
    const current = await currentPullRequest(repository, prNumber, token);
    assertMainBase(current);
    expectedHead = currentHeadSha(current);
    expectedBase = currentBaseSha(current);
  } else {
    throw new Error(`publisher does not support ${eventName || "missing event"}`);
  }

  if (
    artifact.repository !== repository || artifact.prNumber !== prNumber
    || artifact.headSha !== expectedHead || artifact.baseSha !== expectedBase
  ) {
    throw new Error("artifact repository/PR/head/base binding does not match the immutable publication event");
  }
  if (artifact.eventName !== eventName) throw new Error("artifact event type does not match publication event");
  if (gate.prNumber !== prNumber) throw new Error("policy gate PR does not match publication target");
  const files = await changedFileNames(repository, prNumber, token);
  const payload = validateReviewPayload(artifact.review, expectedHead, files);
  // Recheck immediately before the write. A synchronize event may supersede
  // this run while artifact validation/file pagination is in progress.
  const latest = await currentPullRequest(repository, prNumber, token);
  assertMainBase(latest);
  assertCurrentHead(latest, expectedHead);
  assertCurrentBase(latest, expectedBase);
  let response = await githubJson(`/repos/${repository}/pulls/${prNumber}/reviews`, token, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (response.status === 422 && payload.comments.length > 0) {
    response = await githubJson(`/repos/${repository}/pulls/${prNumber}/reviews`, token, {
      method: "POST",
      body: JSON.stringify(foldComments(payload)),
    });
  }
  if (!response.ok) throw new Error(`GitHub rejected the review: HTTP ${response.status}`);
  console.log(`smithers review: published isolated review to ${repository}#${prNumber}`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`smithers review publisher: ${(error as Error).message ?? String(error)}`);
    process.exit(1);
  });
}
