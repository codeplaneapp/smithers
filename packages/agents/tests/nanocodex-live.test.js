import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { NanocodexAgent } from "../src/NanocodexAgent.js";

/**
 * Live Nanocodex coverage is intentionally separate from the shared real-agent
 * gate because it requires both a particular bridge build and a managed
 * ChatGPT credential file. Run it explicitly with:
 *
 *   SMITHERS_RUN_NANOCODEX_LIVE=1 \
 *   SMITHERS_NANOCODEX_BINARY=/absolute/path/to/smithers-nanocodex \
 *   SMITHERS_NANOCODEX_AUTH_FILE=/absolute/path/to/auth.json \
 *   bun test packages/agents/tests/nanocodex-live.test.js
 *
 * Preflight itself is provider-free. The remaining cases make real provider
 * calls and can consume ChatGPT allowance.
 */
const RUN_LIVE = process.env.SMITHERS_RUN_NANOCODEX_LIVE === "1";
const LIVE_TIMEOUT_MS = 300_000;
describe.skipIf(!RUN_LIVE)("NanocodexAgent live bridge (managed ChatGPT auth)", () => {
  /** @type {string} */
  let binary;
  /** @type {string} */
  let authFile;
  /** @type {string} */
  let workspace;

  beforeAll(async () => {
    binary = await requireLiveFile("SMITHERS_NANOCODEX_BINARY", { executable: true });
    authFile = await requireLiveFile("SMITHERS_NANOCODEX_AUTH_FILE");
  });

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "smithers-nanocodex-live-"));
  });

  afterEach(async () => {
    if (workspace) await rm(workspace, { recursive: true, force: true });
  });

  function agent(overrides = {}) {
    return new NanocodexAgent({
      binary,
      cwd: workspace,
      auth: { mode: "chatgpt", authFile },
      timeoutMs: LIVE_TIMEOUT_MS,
      idleTimeoutMs: LIVE_TIMEOUT_MS,
      ...overrides,
    });
  }

  /**
   * @param {{
   *   model: "sol" | "luna";
   *   thinking: "low" | "medium";
   *   expected: "gpt-5.6-sol" | "gpt-5.6-luna";
   * }} request
   */
  async function expectRequestedLiveModel(request) {
    const sentinel = exactToken(request.model.toUpperCase());
    const published = [];
    const lifecycle = [];
    const result = await agent({ model: request.model, thinking: request.thinking }).generate({
      prompt: `Do not use tools. Reply with exactly ${sentinel}`,
      rootDir: workspace,
      onCheckpoint: async (checkpoint) => published.push(checkpoint),
      onProcess: (event) => lifecycle.push(event),
    });
    expect(result.text).toBe(sentinel);
    expect(result.response.modelId).toBe(request.expected);
    expect(result.checkpoint.payload.model).toBe(request.expected);
    expect(published).toHaveLength(1);
    expect(result.checkpoint).toBe(published[0]);
    await expectCleanProcessLifecycle(lifecycle);
  }

  test("preflights the real bridge, protocol, target, and provider-free adapter configuration", async () => {
    await agent().preflight({ rootDir: workspace });
  }, 30_000);

  test(
    "live Sol low returns the requested wire model on the result and checkpoint",
    async () => {
      await expectRequestedLiveModel({ model: "sol", thinking: "low", expected: "gpt-5.6-sol" });
    },
    LIVE_TIMEOUT_MS + 10_000,
  );

  test(
    "live Luna medium returns the requested wire model on the result and checkpoint",
    async () => {
      await expectRequestedLiveModel({ model: "luna", thinking: "medium", expected: "gpt-5.6-luna" });
    },
    LIVE_TIMEOUT_MS + 10_000,
  );

  test(
    "fresh generation returns an exact sentinel and publishes the identical checkpoint object",
    async () => {
      const sentinel = exactToken("FRESH");
      const published = [];
      const lifecycle = [];

      const result = await agent().generate({
        prompt: `Reply with exactly ${sentinel}`,
        rootDir: workspace,
        onCheckpoint: async (checkpoint) => published.push(checkpoint),
        onProcess: (event) => lifecycle.push(event),
      });

      expect(result.text).toBe(sentinel);
      expect(published).toHaveLength(1);
      expect(result.checkpoint).toBe(published[0]);
      await expectCleanProcessLifecycle(lifecycle);
    },
    LIVE_TIMEOUT_MS + 10_000,
  );

  test(
    "a distinct fresh bridge process resumes a checkpoint and recalls a nonce",
    async () => {
      const nonce = exactToken("MEMORY");
      const seedAck = exactToken("STORED");
      const firstLifecycle = [];
      const resumedLifecycle = [];

      const seeded = await agent().generate({
        prompt: `Remember the nonce ${nonce} for the next turn. Reply with exactly ${seedAck}`,
        rootDir: workspace,
        onProcess: (event) => firstLifecycle.push(event),
      });
      expect(seeded.text).toBe(seedAck);

      // Constructing another adapter makes the fresh-process boundary explicit;
      // only the opaque checkpoint carries conversation state into this turn.
      const resumed = await agent().generate({
        prompt: "Reply with exactly the nonce I asked you to remember in the previous turn.",
        rootDir: workspace,
        checkpointMode: "resume",
        resumeCheckpoint: seeded.checkpoint,
        onProcess: (event) => resumedLifecycle.push(event),
      });

      expect(resumed.text).toBe(nonce);
      const firstPid = await expectCleanProcessLifecycle(firstLifecycle);
      const resumedPid = await expectCleanProcessLifecycle(resumedLifecycle);
      expect(resumedPid).not.toBe(firstPid);
    },
    LIVE_TIMEOUT_MS * 2 + 10_000,
  );

  test(
    "native Code Mode creates an exact artifact while lifecycle events stay sanitized and the process exits",
    async () => {
      const artifactName = "nanocodex-code-mode-artifact.txt";
      const privatePayload = exactToken("PRIVATE_ARTIFACT");
      const completionSentinel = exactToken("ARTIFACT_OK");
      const events = [];
      const lifecycle = [];

      const result = await agent().generate({
        prompt: [
          `Use native Code Mode to create the UTF-8 file ${artifactName} in the current workspace.`,
          `The complete file contents must be exactly ${privatePayload} with no trailing newline.`,
          `Verify the file, do not repeat its contents, then reply with exactly ${completionSentinel}`,
        ].join(" "),
        rootDir: workspace,
        onEvent: (event) => events.push(event),
        onProcess: (event) => lifecycle.push(event),
      });

      expect(result.text).toBe(completionSentinel);
      expect(await readFile(join(workspace, artifactName), "utf8")).toBe(privatePayload);

      expect(events.some((event) => event.type === "started" && event.engine === "nanocodex")).toBe(true);
      expect(events.some((event) => event.type === "completed" && event.engine === "nanocodex" && event.ok)).toBe(true);
      const toolEvents = events.filter(
        (event) => event.type === "action" && event.entryType !== "message" && event.action.kind !== "turn",
      );
      expect(toolEvents.some((event) => event.phase === "started")).toBe(true);
      expect(toolEvents.some((event) => event.phase === "completed")).toBe(true);
      for (const event of toolEvents) {
        expect(Object.keys(event.action.detail ?? {}).every((key) => SAFE_TOOL_DETAIL_KEYS.has(key))).toBe(true);
        expect(event.action).not.toHaveProperty("arguments");
        expect(event.action).not.toHaveProperty("result");
      }
      expect(JSON.stringify(events)).not.toContain(privatePayload);
      await expectCleanProcessLifecycle(lifecycle);
    },
    LIVE_TIMEOUT_MS + 10_000,
  );

  test(
    "an abort after turn acceptance routes exact cancellation and cleans up the bridge",
    async () => {
      const controller = new AbortController();
      const reason = new Error("live accepted-turn cancellation sentinel");
      const events = [];
      const lifecycle = [];

      let thrown;
      try {
        await agent().generate({
          prompt:
            "Without using tools, write a very long response containing at least 10000 numbered lines. Begin immediately.",
          rootDir: workspace,
          abortSignal: controller.signal,
          onEvent: (event) => {
            events.push(event);
            if (event.type === "started" && !controller.signal.aborted) controller.abort(reason);
          },
          onProcess: (event) => lifecycle.push(event),
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBe(reason);
      expect(events.some((event) => event.type === "started" && event.engine === "nanocodex")).toBe(true);
      expect(events.some((event) => event.type === "completed" && !event.ok)).toBe(true);
      await expectCleanProcessLifecycle(lifecycle);
    },
    LIVE_TIMEOUT_MS + 10_000,
  );

  test("cancellation during a real native tool stops the contained process tree", async () => {
    const controller = new AbortController();
    const reason = new Error("live native-tool cancellation sentinel");
    const markerPrefix = `nanocodex-live-cancel-${randomUUID()}`;
    const startedName = `${markerPrefix}-started.txt`;
    const finishedName = `${markerPrefix}-finished.txt`;
    const startedMarker = join(workspace, startedName);
    const finishedMarker = join(workspace, finishedName);
    const lifecycle = [];
    let observeToolStart;
    const toolStarted = new Promise((resolve) => {
      observeToolStart = resolve;
    });

    const generation = agent({ timeoutMs: 120_000, idleTimeoutMs: 120_000 }).generate({
      prompt: [
        "Use native Code Mode and run a foreground shell command now.",
        `The command must write started to ${startedName}, sleep for 120 seconds, then write finished to ${finishedName}.`,
        "Do not background the command and do not reply before it finishes.",
      ].join(" "),
      rootDir: workspace,
      abortSignal: controller.signal,
      onEvent: (event) => {
        if (event.type === "action" && event.phase === "started" && event.action.kind !== "turn") {
          observeToolStart();
        }
      },
      onProcess: (event) => lifecycle.push(event),
    });

    let thrown;
    try {
      const firstOutcome = await Promise.race([
        toolStarted.then(() => "tool-started"),
        generation.then(() => "completed"),
        Bun.sleep(90_000).then(() => "timed-out"),
      ]);
      expect(firstOutcome).toBe("tool-started");
      await waitForNonemptyFile(startedMarker, 30_000);
      controller.abort(reason);
      await generation;
    } catch (error) {
      thrown = error;
    } finally {
      if (!controller.signal.aborted) controller.abort(reason);
    }

    expect(thrown).toBe(reason);
    await Bun.sleep(500);
    expect(await fileExists(finishedMarker)).toBe(false);
    await expectCleanProcessLifecycle(lifecycle);
  }, 150_000);
});

const SAFE_TOOL_DETAIL_KEYS = new Set(["modelCallIndex", "durationNs", "status"]);

/** @param {string} prefix */
function exactToken(prefix) {
  return `SMITHERS_NANOCODEX_${prefix}_${randomUUID().replaceAll("-", "").toUpperCase()}`;
}

/**
 * @param {string} name
 * @param {{ executable?: boolean }} [options]
 */
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

/**
 * @param {Array<{ phase: "started" | "exited"; pid: number | undefined }>} lifecycle
 */
async function expectCleanProcessLifecycle(lifecycle) {
  expect(lifecycle.map((event) => event.phase)).toEqual(["started", "exited"]);
  const pid = lifecycle[0]?.pid;
  expect(pid).toBeInteger();
  expect(pid).toBeGreaterThan(0);
  expect(lifecycle[1]?.pid).toBe(pid);

  const deadline = Date.now() + 2_000;
  while ((pidIsAlive(pid) || processGroupIsAlive(pid)) && Date.now() < deadline) await Bun.sleep(10);
  expect(pidIsAlive(pid)).toBe(false);
  expect(processGroupIsAlive(pid)).toBe(false);
  return pid;
}

/** @param {number} pid */
function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function processGroupIsAlive(pid) {
  if (process.platform !== "linux") return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function waitForNonemptyFile(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const size = await stat(path)
      .then((entry) => entry.size)
      .catch(() => 0);
    if (size > 0) return;
    await Bun.sleep(25);
  }
  throw new Error("live native tool did not create its start marker before the deadline");
}

async function fileExists(path) {
  return stat(path).then(
    () => true,
    () => false,
  );
}
