#!/usr/bin/env bun
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

interface Fixture {
  repository: string;
  prNumber: number;
  prView: Record<string, unknown>;
}

const MAX_FIXTURE_BYTES = 1_000_000;
const MAX_CAPTURE_BYTES = 1_000_000;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function safe(value: unknown): string {
  return (value instanceof Error ? value.message : String(value))
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/@(?!\u200b)/g, "@\u200b")
    .slice(0, 240);
}

function fail(message: string): never {
  console.error(`offline gh: ${safe(message)}`);
  process.exit(64);
}

function decode(bytes: Uint8Array, label: string): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error(`${label} is not valid UTF-8`); }
}

function readStableFile(path: string, maxBytes: number, label: string): Buffer {
  const namedBefore = lstatSync(path);
  if (!namedBefore.isFile() || namedBefore.nlink !== 1 || (namedBefore.mode & 0o222) !== 0) {
    throw new Error(`${label} path is not a protected regular file`);
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o222) !== 0
      || before.size < 1 || before.size > maxBytes) throw new Error(`${label} is empty, oversized, or unprotected`);
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new Error(`${label} ended while being read`);
      offset += count;
    }
    const after = fstatSync(fd);
    const namedAfter = lstatSync(path);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || namedBefore.dev !== before.dev || namedBefore.ino !== before.ino
      || namedAfter.dev !== after.dev || namedAfter.ino !== after.ino) throw new Error(`${label} changed while being read`);
    return bytes;
  } finally { closeSync(fd); }
}

function parseFixture(value: unknown): Fixture {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("fixture schema is invalid");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).length !== 3 || !["repository", "prNumber", "prView"].every((key) => key in raw)
    || typeof raw.repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw.repository)
    || raw.repository.split("/").some((part) => part === "." || part === "..")
    || !Number.isSafeInteger(raw.prNumber) || (raw.prNumber as number) < 1
    || !raw.prView || typeof raw.prView !== "object" || Array.isArray(raw.prView)) throw new Error("fixture schema is invalid");
  const pr = raw.prView as Record<string, unknown>;
  const base = pr.base as Record<string, unknown> | undefined;
  const head = pr.head as Record<string, unknown> | undefined;
  const keys = new Set(["number", "url", "baseRefName", "headRefName", "headRefOid", "title", "body", "state", "isDraft", "changed_files", "base", "head"]);
  if (Object.keys(pr).length !== keys.size || Object.keys(pr).some((key) => !keys.has(key))
    || pr.number !== raw.prNumber || typeof pr.url !== "string" || pr.url.length > 2_048
    || typeof pr.baseRefName !== "string" || pr.baseRefName.length < 1 || pr.baseRefName.length > 256
    || typeof pr.headRefName !== "string" || pr.headRefName.length < 1 || pr.headRefName.length > 256
    || typeof pr.headRefOid !== "string" || !SHA.test(pr.headRefOid)
    || typeof pr.title !== "string" || pr.title.length > 20_000
    || typeof pr.body !== "string" || pr.body.length > 200_000
    || pr.state !== "OPEN" || pr.isDraft !== false
    || !Number.isSafeInteger(pr.changed_files) || (pr.changed_files as number) < 1 || (pr.changed_files as number) > 3_000
    || !base || base.ref !== pr.baseRefName || typeof base.sha !== "string" || !SHA.test(base.sha)
    || !head || head.sha !== pr.headRefOid) throw new Error("fixture pull request binding is invalid");
  const url = new URL(pr.url);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || url.pathname !== `/${raw.repository}/pull/${raw.prNumber}`) throw new Error("fixture pull request URL is invalid");
  return { repository: raw.repository, prNumber: raw.prNumber as number, prView: pr };
}

async function readBoundedStdin(): Promise<Buffer> {
  const reader = Bun.stdin.stream().getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_CAPTURE_BYTES) throw new Error("review payload exceeds 1 MB");
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = Buffer.alloc(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function writeExclusiveCapture(path: string, bytes: Uint8Array): void {
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_CAPTURE_BYTES) throw new Error("review capture is empty or oversized");
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let created: ReturnType<typeof fstatSync> | undefined;
  try {
    for (let offset = 0; offset < bytes.byteLength;) {
      const count = writeSync(fd, bytes, offset, bytes.byteLength - offset);
      if (count <= 0) throw new Error("review capture write did not make progress");
      offset += count;
    }
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    created = fstatSync(fd);
  } finally { closeSync(fd); }
  const named = lstatSync(path);
  if (!created || !named.isFile() || named.dev !== created.dev || named.ino !== created.ino || named.size !== bytes.byteLength) {
    throw new Error("review capture pathname changed while being written");
  }
  try {
    const directory = openSync(dirname(path), constants.O_RDONLY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EOPNOTSUPP") throw error;
  }
  const durable = lstatSync(path);
  if (!created || durable.dev !== created.dev || durable.ino !== created.ino || durable.size !== created.size) {
    throw new Error("review capture changed while its directory was synchronized");
  }
}

const fixturePath = process.env.SMITHERS_REVIEW_GH_FIXTURE;
const capturePath = process.env.SMITHERS_REVIEW_CAPTURE_PATH;
if (!fixturePath || !capturePath) fail("fixture/capture path is not configured");

let fixture: Fixture;
try {
  fixture = parseFixture(JSON.parse(decode(readStableFile(fixturePath, MAX_FIXTURE_BYTES, "fixture"), "fixture")));
} catch (error) {
  fail(`could not read fixture: ${safe(error)}`);
}

const args = process.argv.slice(2);
const endpoint = `repos/${fixture.repository}/pulls/${fixture.prNumber}`;

if (args[0] === "pr" && args[1] === "view" && args[2] === String(fixture.prNumber)) {
  process.stdout.write(JSON.stringify(fixture.prView));
  process.exit(0);
}

if (args[0] === "api" && args.includes("user") && args.includes(".login")) {
  process.stdout.write("smithers-review");
  process.exit(0);
}

if (args[0] === "api" && args.includes(`${endpoint}/files`)) fail("changed-file capabilities are available only through the protected manifest");

if (args[0] === "api" && args.includes(endpoint) && !args.includes("--method")) {
  process.stdout.write(JSON.stringify(fixture.prView));
  process.exit(0);
}

if (args[0] === "api" && args.includes(`${endpoint}/reviews`) && !args.includes("--method")) process.exit(0);

if (
  args[0] === "api"
  && args.includes("--method")
  && args[args.indexOf("--method") + 1] === "POST"
  && args.includes(`${endpoint}/reviews`)
) {
  try {
    const raw = await readBoundedStdin();
    const parsed = JSON.parse(decode(raw, "review payload")) as unknown;
    writeExclusiveCapture(capturePath, Buffer.from(JSON.stringify(parsed)));
    process.stdout.write(JSON.stringify({ html_url: fixture.prView.url }));
    process.exit(0);
  } catch (error) {
    fail(`could not capture review: ${safe(error)}`);
  }
}

fail(`command is outside the read/capture allowlist: ${args.join(" ")}`);
