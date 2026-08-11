import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, readFileSync } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SmithersDb } from "@smthrs/db/adapter";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Effect } from "effect";
import { nanocodexTestSupported } from "./nanocodex-host-support.js";

const RUN_LIVE = process.env.SMITHERS_RUN_NANOCODEX_LIVE === "1";
const LIVE_TIMEOUT_MS = 300_000;
const LIVE_CHILD_TIMEOUT_MS = LIVE_TIMEOUT_MS + 30_000;
const FAKE_CHILD_TIMEOUT_MS = 30_000;
const PROCESS_EXIT_TIMEOUT_MS = 5_000;
const PROCESS_GONE_TIMEOUT_MS = 2_000;
const MAX_CAPTURE_BYTES = 128 * 1024;
const CONTROLLED_INVALID_TEXT = "SMITHERS_NANOCODEX_CONTROLLED_INVALID_OUTPUT";
const CHECKPOINT_CODEC = "nanocodex.session-snapshot";
const CHECKPOINT_VERSION = 1;
const FIXTURE = fileURLToPath(new URL("./fixtures/nanocodex-live-restart.fixture.mjs", import.meta.url));
const FAKE_BRIDGE_FIXTURE = fileURLToPath(
  new URL("./fixtures/nanocodex-restart-fake-bridge.fixture.mjs", import.meta.url),
);

const childHandles = new Set();
const tempRoots = new Set();
const cleanupBridgeGroups = new Map();

afterEach(async () => {
  for (const handle of childHandles) {
    if (!handle.outcome) killTrackedProcessGroup(handle.identity);
  }
  await Promise.allSettled([...childHandles].map((handle) => waitForExit(handle, PROCESS_EXIT_TIMEOUT_MS)));
  childHandles.clear();

  await cleanupRecordedBridgeGroups();
  for (const identity of cleanupBridgeGroups.values()) killTrackedProcessGroup(identity);
  cleanupBridgeGroups.clear();

  await Promise.allSettled(
    [...tempRoots].map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
  tempRoots.clear();
});

describe.skipIf(!nanocodexTestSupported)("Nanocodex provider-free Smithers cold restart", () => {
  test(
    "resumes an exact fake checkpoint from durable SQLite in a fresh process",
    async () => {
      await runColdRestartScenario({ kind: "fake", childTimeoutMs: FAKE_CHILD_TIMEOUT_MS });
    },
    FAKE_CHILD_TIMEOUT_MS * 2,
  );
});

/**
 * This remains separate from provider-free qualification and makes exactly
 * two real managed-ChatGPT turns:
 *
 *   SMITHERS_RUN_NANOCODEX_LIVE=1 \
 *   SMITHERS_NANOCODEX_BINARY=/absolute/path/to/smithers-nanocodex \
 *   SMITHERS_NANOCODEX_AUTH_FILE=/absolute/path/to/auth.json \
 *   bun test packages/engine/tests/nanocodex-live-workflow.test.js
 */
describe.skipIf(!RUN_LIVE)("Nanocodex live Smithers cold restart", () => {
  test(
    "resumes an exact real checkpoint from SQLite after the first Smithers process is SIGKILLed",
    async () => {
      if (process.platform !== "linux") throw new Error("This opt-in cold-restart test requires Linux process groups.");
      const binary = await requireLiveFile("SMITHERS_NANOCODEX_BINARY", { executable: true });
      const authFile = await requireLiveFile("SMITHERS_NANOCODEX_AUTH_FILE");
      await runColdRestartScenario({
        authFile,
        binary,
        childTimeoutMs: LIVE_CHILD_TIMEOUT_MS,
        kind: "live",
      });
    },
    LIVE_TIMEOUT_MS * 2 + 90_000,
  );
});

async function runColdRestartScenario({ authFile, binary: configuredBinary, childTimeoutMs, kind }) {
  const root = await mkdtemp(join(tmpdir(), `smithers-nanocodex-${kind}-restart-`));
  tempRoots.add(root);
  const workspace = join(root, "workspace");
  const markerDir = join(root, "markers");
  await Promise.all([mkdir(workspace), mkdir(markerDir)]);
  const canonicalWorkspace = await realpath(workspace);
  const dbPath = join(root, "smithers.sqlite");
  const configPath = join(root, "config.json");
  const bridgeCapture = join(markerDir, "fake-bridge-captures.jsonl");
  const nonce = `SMITHERS_NANOCODEX_RESTART_${kind.toUpperCase()}_${randomUUID().replaceAll("-", "").toUpperCase()}`;
  const runId = `nanocodex-${kind}-restart-${randomUUID()}`;
  let binary = configuredBinary;

  if (kind === "fake") {
    binary = join(root, "fake-nanocodex-bridge.mjs");
    const source = (await readFile(FAKE_BRIDGE_FIXTURE, "utf8")).replace(/^#![^\n]*/u, `#!${process.execPath}`);
    await writeFile(binary, source, "utf8");
    await chmod(binary, 0o755);
  }
  if (typeof binary !== "string" || !binary) throw new Error("restart scenario requires a bridge binary");

  await writeFile(
    configPath,
    JSON.stringify({
      blockMs: kind === "live" ? LIVE_TIMEOUT_MS * 2 : FAKE_CHILD_TIMEOUT_MS * 2,
      bridgeCapture,
      dbPath,
      kind,
      markerDir,
      nonce,
      runId,
      turnTimeoutMs: kind === "live" ? LIVE_TIMEOUT_MS : 10_000,
      workspace: canonicalWorkspace,
    }),
    "utf8",
  );

  const initial = spawnFixture("initial", configPath, { authFile, binary });
  const ready = await waitForJsonMarker(
    join(markerDir, "retry-ready.json"),
    initial,
    childTimeoutMs,
    "process A durable retry cutpoint",
  );
  expect(ready).toEqual({
    checkpointMode: "resume",
    checkpointHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
    processInstanceId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
  });

  const initialLifecycle = await readJsonLines(join(markerDir, "lifecycle-initial.jsonl"));
  const initialBridgeIdentity = await expectCleanLifecycle(initialLifecycle);

  let initialCheckpoint;
  let initialRef;
  let initialResumeRef;
  await withReadonlyDb(dbPath, async ({ adapter }) => {
    expect((await Effect.runPromise(adapter.getRun(runId)))?.status).toBe("running");

    // The adapter publishes the snapshot mid-turn through `onCheckpoint` and
    // returns that same checkpoint from the turn, so every attempt reaching a
    // completed turn records a `progress` ref plus a companion `turn` ref over
    // byte-identical content. The `progress` ref is the durable lineage the
    // later assertions track; the retry resumes from the newest ref of the two.
    const refs = await Effect.runPromise(adapter.listAgentCheckpointRefs(runId, { nodeId: "work" }));
    expect(refs.map((ref) => ref.purpose)).toEqual(["progress", "turn"]);
    initialRef = refs[0];
    initialResumeRef = refs[1];
    expect(initialRef).toMatchObject({
      attempt: 1,
      sequence: 0,
      codec: CHECKPOINT_CODEC,
      version: CHECKPOINT_VERSION,
      purpose: "progress",
    });
    expect(initialResumeRef).toMatchObject({
      attempt: 1,
      sequence: 1,
      codec: CHECKPOINT_CODEC,
      version: CHECKPOINT_VERSION,
      purpose: "turn",
      contentHash: initialRef.contentHash,
    });
    expect(ready.checkpointHash).toBe(initialRef.contentHash);

    const content = await Effect.runPromise(adapter.getAgentCheckpoint(initialRef.contentHash));
    initialCheckpoint = expectStoredCheckpoint(content, initialRef);

    const attempts = await Effect.runPromise(adapter.listAttempts(runId, "work", 0));
    expect(attempts.map((attempt) => attempt.state).sort()).toEqual(["failed", "in-progress"]);
    const failedAttempt = attempts.find((attempt) => attempt.state === "failed");
    expect(failedAttempt).toMatchObject({ attempt: 1, responseText: CONTROLLED_INVALID_TEXT });
    const activeAttempt = attempts.find((attempt) => attempt.state === "in-progress");
    expect(activeAttempt).toBeDefined();
    expect(JSON.parse(activeAttempt?.metaJson ?? "{}").resumedFromCheckpoint).toEqual({
      contentHash: initialResumeRef.contentHash,
      sequence: initialResumeRef.sequence,
      codec: CHECKPOINT_CODEC,
      version: CHECKPOINT_VERSION,
      mode: "resume",
    });
  });
  expect(await readJsonLines(join(markerDir, "provider-calls.jsonl"))).toEqual([
    { mode: "initial", continuation: "fresh" },
  ]);

  signalTrackedProcess(initial.identity, "SIGKILL");
  const initialExit = await waitForExit(initial, PROCESS_EXIT_TIMEOUT_MS);
  expect(initialExit).toEqual({ code: null, signal: "SIGKILL" });
  await expectProcessTreeGone(initial.identity);
  childHandles.delete(initial);

  const resumed = spawnFixture("resume", configPath, { authFile, binary });
  const resumedExit = await waitForExit(resumed, childTimeoutMs);
  if (resumedExit.code !== 0 || resumedExit.signal !== null) {
    throw childFailure("process B did not finish", resumed, resumedExit);
  }
  const resumedStatus = resultRecord(resumed.stdout());
  expect(resumedStatus).toEqual({
    mode: "resume",
    pid: resumed.child.pid,
    processInstanceId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
    status: "finished",
  });
  await expectProcessTreeGone(resumed.identity);
  childHandles.delete(resumed);

  const resumedMarker = await readJson(join(markerDir, "resumed-received.json"));
  expect(resumedMarker).toEqual({
    checkpointMode: "resume",
    checkpointHash: initialRef.contentHash,
    processInstanceId: resumedStatus.processInstanceId,
  });
  expect(resumedStatus.processInstanceId).not.toBe(ready.processInstanceId);
  expect(resumed.identity).not.toEqual(initial.identity);

  const resumedLifecycle = await readJsonLines(join(markerDir, "lifecycle-resume.jsonl"));
  const resumedBridgeIdentity = await expectCleanLifecycle(resumedLifecycle);
  expect(resumedBridgeIdentity).not.toEqual(initialBridgeIdentity);

  await withReadonlyDb(dbPath, async ({ adapter, sqlite }) => {
    expect((await Effect.runPromise(adapter.getRun(runId)))?.status).toBe("finished");
    expect(
      sqlite
        .query("SELECT value, nonce FROM result WHERE run_id = ? AND node_id = 'work' AND iteration = 0")
        .all(runId),
    ).toEqual([{ value: 42, nonce }]);

    const refs = await Effect.runPromise(adapter.listAgentCheckpointRefs(runId, { nodeId: "work" }));
    // The adapter publishes mid-turn through `onCheckpoint` and also returns
    // the same checkpoint, so the substrate additionally records a `turn` ref
    // for the successful attempt. Assert on the durable progress lineage.
    const progressRefs = refs.filter((ref) => ref.purpose === "progress");
    expect(progressRefs).toHaveLength(2);
    expect(refs.every((ref) => ref.codec === CHECKPOINT_CODEC && ref.version === CHECKPOINT_VERSION)).toBe(true);
    expect(progressRefs[0]).toEqual(initialRef);
    expect(progressRefs[1]).toMatchObject({
      sequence: 0,
      codec: CHECKPOINT_CODEC,
      version: CHECKPOINT_VERSION,
      purpose: "progress",
    });
    expect(progressRefs[1].contentHash).not.toBe(initialRef.contentHash);
    expect(await Effect.runPromise(adapter.getAgentCheckpoint(initialRef.contentHash))).not.toBeNull();
    const secondContent = await Effect.runPromise(adapter.getAgentCheckpoint(progressRefs[1].contentHash));
    expectStoredCheckpoint(secondContent, progressRefs[1]);

    expect(await Effect.runPromise(adapter.listInProgressAttempts(runId))).toEqual([]);
    const attempts = await Effect.runPromise(adapter.listAttempts(runId, "work", 0));
    expect(attempts.map((attempt) => attempt.state).sort()).toEqual(["cancelled", "failed", "finished"]);
    const successfulAttempts = attempts.filter((attempt) => attempt.state === "finished");
    expect(successfulAttempts).toHaveLength(1);
    const successfulAttempt = successfulAttempts[0];
    expect(successfulAttempt.finishedAtMs).toBeNumber();
    expect(progressRefs[1].attempt).toBe(successfulAttempt.attempt);
    expect(JSON.parse(successfulAttempt.metaJson ?? "{}").resumedFromCheckpoint).toEqual({
      contentHash: initialResumeRef.contentHash,
      sequence: initialResumeRef.sequence,
      codec: CHECKPOINT_CODEC,
      version: CHECKPOINT_VERSION,
      mode: "resume",
    });
  });

  expect(await readJsonLines(join(markerDir, "provider-calls.jsonl"))).toEqual([
    { mode: "initial", continuation: "fresh" },
    { mode: "resume", continuation: "resume" },
  ]);

  if (kind === "fake") {
    const captures = await readJsonLines(bridgeCapture);
    expect(captures).toHaveLength(2);
    expect(new Set(captures.map((capture) => capture.instanceId)).size).toBe(2);
    expect(captures[0].command.data.continuation).toBeNull();
    expect(captures[0].command.data.prompt).toContain(nonce);
    expect(captures[1].command.data.continuation).toEqual({
      mode: "resume",
      snapshot: initialCheckpoint.payload.nanocodexSnapshot,
    });
    expect(captures[1].command.data.prompt).not.toContain(nonce);
    expect(captures[1].command.data.prompt).toContain("recall the nonce");
  }
}

function expectStoredCheckpoint(content, ref) {
  expect(content).not.toBeNull();
  expect(content.contentHash).toBe(ref.contentHash);
  expect(Buffer.byteLength(content.checkpointJson, "utf8")).toBe(content.sizeBytes);
  expect(createHash("sha256").update(content.checkpointJson).digest("hex")).toBe(ref.contentHash);
  const checkpoint = JSON.parse(content.checkpointJson);
  expect(checkpoint).toMatchObject({ codec: CHECKPOINT_CODEC, version: CHECKPOINT_VERSION });
  expect(ref).toMatchObject({ codec: CHECKPOINT_CODEC, version: CHECKPOINT_VERSION });
  return checkpoint;
}

function spawnFixture(mode, configPath, paths) {
  const child = spawn(process.execPath, ["run", FIXTURE, mode, configPath], {
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      SMITHERS_BACKEND: "sqlite",
      SMITHERS_HOT: "0",
      SMITHERS_NANOCODEX_BINARY: paths.binary,
      ...(paths.authFile ? { SMITHERS_NANOCODEX_AUTH_FILE: paths.authFile } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = boundedCapture(child.stdout);
  const stderr = boundedCapture(child.stderr);
  const handle = {
    child,
    identity: readProcessIdentity(child.pid),
    outcome: null,
    spawnError: null,
    stdout,
    stderr,
  };
  handle.exited = new Promise((resolve) => {
    child.once("error", (error) => {
      handle.spawnError = error;
    });
    child.once("close", (code, signal) => {
      handle.outcome = { code, signal };
      resolve(handle.outcome);
    });
  });
  childHandles.add(handle);
  return handle;
}

function boundedCapture(stream) {
  const chunks = [];
  let bytes = 0;
  let truncated = false;
  stream?.on("data", (chunk) => {
    const buffer = Buffer.from(chunk);
    const remaining = Math.max(0, MAX_CAPTURE_BYTES - bytes);
    if (remaining > 0) {
      const kept = buffer.subarray(0, remaining);
      chunks.push(kept);
      bytes += kept.byteLength;
    }
    if (buffer.byteLength > remaining) truncated = true;
  });
  return () => `${Buffer.concat(chunks).toString("utf8")}${truncated ? "\n[output truncated]" : ""}`;
}

async function waitForJsonMarker(path, handle, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastParseError;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") lastParseError = error;
    }
    if (handle.spawnError || handle.outcome) {
      throw childFailure(`${label} was not reached`, handle, handle.outcome, lastParseError);
    }
    await Bun.sleep(25);
  }
  killTrackedProcessGroup(handle.identity);
  throw childFailure(`timed out waiting for ${label}`, handle, handle.outcome, lastParseError);
}

async function waitForExit(handle, timeoutMs) {
  if (handle.outcome) return handle.outcome;
  let timer;
  try {
    return await Promise.race([
      handle.exited,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          killTrackedProcessGroup(handle.identity);
          reject(childFailure("child exit timed out", handle, handle.outcome));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function childFailure(message, handle, outcome, cause) {
  const spawnError = handle.spawnError instanceof Error ? handle.spawnError.message : null;
  const markerError = cause instanceof Error ? cause.message : null;
  return new Error(
    `${message} (${JSON.stringify({ outcome, spawnError, markerError })})\nstdout:\n${handle.stdout()}\nstderr:\n${handle.stderr()}`,
  );
}

function signalTrackedProcess(identity, signal) {
  if (!sameProcessIdentity(identity, readProcessIdentity(identity?.pid))) {
    throw new Error(`refusing to signal a stale process identity: ${JSON.stringify(identity)}`);
  }
  process.kill(identity.pid, signal);
}

function killTrackedProcessGroup(identity) {
  if (!sameProcessIdentity(identity, readProcessIdentity(identity?.pid))) return;
  try {
    process.kill(process.platform === "win32" ? identity.pid : -identity.pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function expectCleanLifecycle(lifecycle) {
  expect(lifecycle.map((event) => event.phase)).toEqual(["started", "exited"]);
  const started = lifecycle[0];
  const exited = lifecycle[1];
  expect(started?.pid).toBeInteger();
  expect(started?.pid).toBeGreaterThan(0);
  expect(started?.startTimeTicks).toMatch(/^\d+$/u);
  expect(exited).toEqual(started && { ...started, phase: "exited" });
  const identity = { pid: started.pid, startTimeTicks: started.startTimeTicks };
  cleanupBridgeGroups.set(processIdentityKey(identity), identity);
  await expectProcessTreeGone(identity);
  cleanupBridgeGroups.delete(processIdentityKey(identity));
  return identity;
}

async function cleanupRecordedBridgeGroups() {
  for (const root of tempRoots) {
    for (const mode of ["initial", "resume"]) {
      const lifecycle = await readJsonLines(join(root, "markers", `lifecycle-${mode}.jsonl`)).catch(() => []);
      for (const identity of activeLifecycleIdentities(lifecycle)) killTrackedProcessGroup(identity);
    }
  }
}

function activeLifecycleIdentities(lifecycle) {
  const active = new Map();
  for (const event of lifecycle) {
    if (!Number.isInteger(event?.pid) || event.pid <= 0 || !/^\d+$/u.test(event?.startTimeTicks ?? "")) continue;
    const identity = { pid: event.pid, startTimeTicks: event.startTimeTicks };
    const key = processIdentityKey(identity);
    if (event.phase === "started") active.set(key, identity);
    if (event.phase === "exited") active.delete(key);
  }
  return active.values();
}

async function expectProcessTreeGone(identity) {
  const deadline = Date.now() + PROCESS_GONE_TIMEOUT_MS;
  while ((processIdentityIsAlive(identity) || processGroupIsAlive(identity?.pid)) && Date.now() < deadline) {
    await Bun.sleep(10);
  }
  expect(processIdentityIsAlive(identity)).toBe(false);
  if (process.platform !== "win32") expect(processGroupIsAlive(identity?.pid)).toBe(false);
}

function readProcessIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform !== "linux") return { pid, startTimeTicks: null };
  try {
    const procStat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fieldsAfterCommand = procStat
      .slice(procStat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/u);
    const startTimeTicks = fieldsAfterCommand[19];
    return /^\d+$/u.test(startTimeTicks ?? "") ? { pid, startTimeTicks } : null;
  } catch {
    return null;
  }
}

function processIdentityIsAlive(identity) {
  return sameProcessIdentity(identity, readProcessIdentity(identity?.pid));
}

function sameProcessIdentity(left, right) {
  return (
    left !== null &&
    right !== null &&
    left !== undefined &&
    right !== undefined &&
    left.pid === right.pid &&
    left.startTimeTicks === right.startTimeTicks
  );
}

function processIdentityKey(identity) {
  return `${identity.pid}:${identity.startTimeTicks}`;
}

function processGroupIsAlive(pid) {
  return process.platform !== "win32" && signalTargetIsAlive(-pid);
}

function signalTargetIsAlive(target) {
  if (!Number.isInteger(target) || target === 0) return false;
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function withReadonlyDb(path, use) {
  const sqlite = new Database(path, { readonly: true });
  sqlite.exec("PRAGMA busy_timeout = 30000");
  const adapter = new SmithersDb(drizzle(sqlite));
  try {
    return await use({ adapter, sqlite });
  } finally {
    sqlite.close();
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readJsonLines(path) {
  const text = (await readFile(path, "utf8")).trim();
  return text ? text.split("\n").map((line) => JSON.parse(line)) : [];
}

function resultRecord(stdout) {
  const prefix = "NANOCODEX_RESTART_RESULT=";
  const line = stdout
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(prefix));
  if (!line) throw new Error("process B did not emit its bounded result record");
  return JSON.parse(line.slice(prefix.length));
}

async function requireLiveFile(name, options = {}) {
  const value = process.env[name];
  if (!value || !isAbsolute(value)) {
    throw new Error(`${name} must be set to an explicit absolute path when SMITHERS_RUN_NANOCODEX_LIVE=1.`);
  }
  const canonical = await realpath(value).catch(() => undefined);
  if (!canonical || !(await stat(canonical)).isFile()) {
    throw new Error(`${name} must identify an existing regular file.`);
  }
  if (options.executable) {
    await access(canonical, fsConstants.X_OK).catch(() => {
      throw new Error(`${name} must identify an executable file.`);
    });
  }
  return canonical;
}
