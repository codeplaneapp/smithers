import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { errorToJson } from "@smthrs/errors/errorToJson";

import { NanocodexAgent } from "../src/NanocodexAgent.js";

const HOST_TARGET =
  process.platform === "darwin" && process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-unknown-linux-gnu";

const CAPABILITIES = {
  bridgeVersion: "0.0.2",
  target: HOST_TARGET,
  nanocodexVersion: "0.5.0",
  protocol: { name: "smithers.nanocodex", versions: [1] },
  checkpoint: {
    codec: "nanocodex.session-snapshot",
    codecVersions: [1],
    snapshotVersions: [1],
    continuationModes: ["resume"],
    resumeRequiresSameCanonicalWorkspace: true,
  },
  authenticationModes: ["api-key-env", "chatgpt"],
  transportModes: ["websocket"],
  models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
  defaultModel: "gpt-5.6-sol",
  thinkingLevels: ["none", "low", "medium", "high", "xhigh", "max"],
  defaultThinking: "high",
  reasoningModes: ["standard", "pro"],
  features: {
    codeMode: true,
    codeModeDisable: false,
    websocketHttpsFallback: true,
    customEndpoints: false,
    mcp: false,
    subagents: false,
    steering: false,
    workspaceRelocation: false,
  },
  limits: {
    maxInputRecordBytes: 24 * 1024 * 1024,
    maxOutputRecordBytes: 40 * 1024 * 1024,
    maxPromptBytes: 4 * 1024 * 1024,
    maxSnapshotBytes: 15 * 1024 * 1024,
    maxEventBytes: 1024 * 1024,
    maxEventTotalBytes: 16 * 1024 * 1024,
    maxStderrBytes: 64 * 1024,
    maxCommandRecords: 256,
    maxJsonDepth: 64,
    maxJsonNodes: 262_144,
    maxJsonObjectMembers: 16_384,
    maxJsonArrayElements: 131_072,
    maxJsonStringBytes: 18 * 1024 * 1024,
    maxJsonKeyBytes: 1_024,
    maxManagedAuthFileBytes: 1_024 * 1_024,
  },
};

const runtimeGlibc = process.report?.getReport?.().header?.glibcVersionRuntime;
const [glibcMajor = 0, glibcMinor = 0] = typeof runtimeGlibc === "string" ? runtimeGlibc.split(".").map(Number) : [];
const supportedNanocodexHost =
  (process.platform === "darwin" && process.arch === "arm64") ||
  (process.platform === "linux" &&
    process.arch === "x64" &&
    (glibcMajor > 2 || (glibcMajor === 2 && glibcMinor >= 35)));

describe.skipIf(!supportedNanocodexHost)("NanocodexAgent", () => {
  let directory;
  let binary;
  let capture;
  let lifecycle;

  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), "smithers-nanocodex-agent-")));
    binary = join(directory, "fake-smithers-nanocodex.mjs");
    capture = join(directory, "commands.jsonl");
    lifecycle = join(directory, "lifecycle.log");
    await writeFile(binary, fakeBridgeSource(lifecycle), "utf8");
    await chmod(binary, 0o755);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function agent(extra = {}) {
    return new NanocodexAgent({
      binary,
      cwd: directory,
      auth: { mode: "api-key-env", environmentVariable: "FAKE_NANOCODEX_KEY" },
      inheritEnv: false,
      cancellationGraceMs: 200,
      ...extra,
      env: {
        FAKE_NANOCODEX_KEY: "test-key-never-on-the-wire",
        FAKE_CAPTURE: capture,
        ...extra.env,
      },
    });
  }

  test("preflights capabilities without constructing a turn", async () => {
    const instance = new NanocodexAgent({
      binary,
      cwd: directory,
      auth: { mode: "api-key-env", environmentVariable: "MISSING_NANOCODEX_KEY" },
      inheritEnv: false,
      env: { PATH: process.env.PATH ?? "" },
    });
    await instance.preflight({ rootDir: directory });
    expect(await readFile(capture, "utf8").catch(() => "")).toBe("");
    expect((await readFile(lifecycle, "utf8")).trim().split("\n")).toEqual([
      "capabilities-start",
      "capabilities-close",
    ]);
  });

  test("does not inject ambient PATH into preflight when environment inheritance is disabled", async () => {
    await writeFile(binary, fakeBridgeSource(lifecycle, true), "utf8");
    const instance = new NanocodexAgent({
      binary,
      cwd: directory,
      auth: { mode: "chatgpt" },
      inheritEnv: false,
      env: {},
    });
    await instance.preflight({ rootDir: directory });
    expect((await readFile(lifecycle, "utf8")).trim().split("\n")).toEqual([
      "capabilities-start",
      "capabilities-path-absent",
      "capabilities-close",
    ]);
  });

  test("resolves a bare bridge from explicit PATH with inheritEnv disabled", async () => {
    const instance = new NanocodexAgent({
      binary: basename(binary),
      cwd: directory,
      auth: { mode: "api-key-env", environmentVariable: "FAKE_NANOCODEX_KEY" },
      inheritEnv: false,
      env: {
        PATH: directory,
        FAKE_NANOCODEX_KEY: "private-key",
        FAKE_CAPTURE: capture,
      },
    });
    const result = await instance.generate({ prompt: "explicit PATH", rootDir: directory });
    expect(result.text).toBe("deterministic answer");
    expect((await readFile(lifecycle, "utf8")).trim().split("\n")).toEqual([
      "capabilities-start",
      "capabilities-close",
      "serve-start",
    ]);
  });

  test("keeps bridge internals private with matching Bun and Node package behavior", async () => {
    const specifiers = [
      "@smthrs/agents/nanocodex/protocol",
      "@smthrs/agents/nanocodex/process",
      "@smthrs/agents/nanocodex/checkpoint",
      "@smthrs/agents/internal/nanocodex/protocol",
    ];
    for (const specifier of specifiers) {
      await expect(import(specifier)).rejects.toBeDefined();
    }
    expect(typeof (await import("@smthrs/agents")).NanocodexAgent).toBe("function");

    const node = Bun.which("node");
    expect(node).toBeTruthy();
    const script = `for (const specifier of ${JSON.stringify(specifiers)}) {
      try { await import(specifier); process.exit(1); } catch {}
    }`;
    const result = spawnSync(node, ["--input-type=module", "-e", script], { cwd: process.cwd() });
    expect(result.status).toBe(0);
  });

  test("suppresses credentials and raw stderr from failed capability preflight", async () => {
    const secret = "CAPABILITY_SECRET_SENTINEL";
    await writeFile(
      binary,
      `#!${process.execPath}\nprocess.stderr.write(${JSON.stringify(secret)} + String(process.env.FAKE_NANOCODEX_KEY));\nprocess.exit(9);\n`,
      "utf8",
    );
    await chmod(binary, 0o755);
    let caught;
    try {
      await agent({ env: { FAKE_NANOCODEX_KEY: secret } }).preflight({ rootDir: directory });
    } catch (error) {
      caught = error;
    }
    const durableError = JSON.stringify(errorToJson(caught));
    expect(caught).toMatchObject({ code: "AGENT_CONFIG_INVALID", cause: undefined });
    expect(durableError).not.toContain(secret);
    expect(durableError).not.toContain("test-key-never-on-the-wire");
    expect(durableError.length).toBeLessThan(16_000);
  });

  test("runs one stock turn, sanitizes events, and publishes the identical checkpoint", async () => {
    const instance = agent({ env: { FAKE_MODE: "secret-metadata" } });
    const published = [];
    const events = [];
    const processes = [];
    let streamed = "";
    const result = await instance.generate({
      prompt: "perform the task",
      rootDir: directory,
      maxAgentCheckpointBytes: 1024 * 1024,
      onCheckpoint: async (checkpoint) => published.push(checkpoint),
      onStdout: (text) => {
        streamed += text;
      },
      onEvent: (event) => events.push(event),
      onProcess: (event) => processes.push(event.phase),
    });

    expect(result.text).toBe("deterministic answer");
    expect(result.response.modelId).toBe("gpt-5.6-sol");
    expect(result.checkpoint.payload.model).toBe("gpt-5.6-sol");
    expect(result.response.messages).toEqual([
      { role: "assistant", content: [{ type: "text", text: "deterministic answer" }] },
    ]);
    expect(result.usage).toMatchObject({
      inputTokens: 11,
      inputTokenDetails: { noCacheTokens: 6, cacheReadTokens: 3, cacheWriteTokens: 2 },
      outputTokens: 7,
      outputTokenDetails: { textTokens: 5, reasoningTokens: 2 },
      totalTokens: 18,
    });
    expect(streamed).toBe("deterministic ");
    expect(published).toHaveLength(1);
    expect(result.checkpoint).toBe(published[0]);
    expect(result.checkpoint.payload.policyFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(JSON.stringify(events)).not.toContain("secret-tool-argument");
    expect(JSON.stringify(events)).not.toContain("secret-tool-result");
    expect(JSON.stringify(events)).not.toContain("secret-metadata");
    expect(events.find((event) => event.type === "started")).toEqual({
      type: "started",
      engine: "nanocodex",
      title: "Nanocodex turn",
    });
    expect(events.some((event) => event.type === "completed" && event.ok)).toBe(true);
    const toolEvents = events.filter((event) => event.type === "action" && event.action?.id === "tool-1");
    expect(toolEvents.map((event) => event.action.detail)).toEqual([
      { modelCallIndex: 1 },
      { durationNs: 10, status: "completed" },
    ]);
    expect(processes).toEqual(["started", "exited"]);
    expect((await readFile(lifecycle, "utf8")).trim().split("\n")).toEqual([
      "capabilities-start",
      "capabilities-close",
      "serve-start",
    ]);

    const commands = await capturedCommands(capture);
    expect(commands).toHaveLength(1);
    expect(commands[0].data.prompt).toBe("perform the task");
    expect(commands[0].data.continuation).toBeNull();
    expect(JSON.stringify(commands[0])).not.toContain("test-key-never-on-the-wire");
  });

  test("forwards the explicit stock-agent policy/auth options and applies workspace precedence", async () => {
    const constructorWorkspace = await realpath(await mkdtemp(join(tmpdir(), "smithers-nanocodex-constructor-")));
    const callWorkspace = await realpath(await mkdtemp(join(tmpdir(), "smithers-nanocodex-call-")));
    try {
      await agent({
        cwd: constructorWorkspace,
        auth: { mode: "chatgpt", authFile: join(directory, "managed-auth.json") },
        instructions: "Complete replacement instructions.",
        thinking: "xhigh",
        reasoningMode: "pro",
        fastMode: true,
      }).generate({ prompt: "configured", rootDir: callWorkspace });

      const [command] = await capturedCommands(capture);
      expect(command.data.workspace).toBe(callWorkspace);
      expect(command.data.auth).toEqual({ mode: "chatgpt", authFile: join(directory, "managed-auth.json") });
      expect(command.data.options).toEqual({
        instructions: "Complete replacement instructions.",
        model: "gpt-5.6-sol",
        thinking: "xhigh",
        reasoningMode: "pro",
        fastMode: true,
      });
    } finally {
      await rm(constructorWorkspace, { recursive: true, force: true });
      await rm(callWorkspace, { recursive: true, force: true });
    }
  });

  test("forwards allowlisted Sol/Terra/Luna models and stamps the completed wire model", async () => {
    const result = await agent({ model: "terra" }).generate({ prompt: "terra", rootDir: directory });
    expect(result.response.modelId).toBe("gpt-5.6-terra");
    expect(result.checkpoint.payload.model).toBe("gpt-5.6-terra");
    expect((await capturedCommands(capture))[0].data.options.model).toBe("gpt-5.6-terra");
    const luna = await agent({ model: "luna" }).generate({ prompt: "luna", rootDir: directory });
    expect(luna.response.modelId).toBe("gpt-5.6-luna");
    expect(luna.checkpoint.payload.model).toBe("gpt-5.6-luna");
  });

  test("matches Rust Unicode whitespace and scalar rules at the public adapter boundary", async () => {
    await expect(agent().generate({ prompt: "\u0085", rootDir: directory })).rejects.toThrow(
      "non-empty Unicode scalar prompt",
    );
    await expect(agent().generate({ prompt: "\ud800", rootDir: directory })).rejects.toThrow(
      "non-empty Unicode scalar prompt",
    );

    const accepted = await agent().generate({ prompt: "\ufeff", rootDir: directory });
    expect(accepted.text).toBe("deterministic answer");
    expect((await capturedCommands(capture))[0].data.prompt).toBe("\ufeff");

    expect(new NanocodexAgent().model).toBe("gpt-5.6-sol");
    expect(new NanocodexAgent({ model: "luna" }).model).toBe("gpt-5.6-luna");
    expect(() => new NanocodexAgent({ model: "gpt-4o" })).toThrow("unsupported");
    expect(() => new NanocodexAgent({ instructions: "\u0085" })).toThrow("non-empty Unicode scalar text");
    expect(() => new NanocodexAgent({ instructions: "\ufeff" })).not.toThrow();
    expect(() => new NanocodexAgent({ auth: { mode: "chatgpt", authFile: "/\ud800" } })).toThrow("managed authFile");
  });

  test("serializes managed-auth turns across instances and preserves an aborted waiter's queue order", async () => {
    const authFile = join(directory, "managed-auth.json");
    const authAlias = join(directory, "managed-auth-alias.json");
    const startBarrier = join(directory, "managed-starts.log");
    const releaseBarrier = join(directory, "managed-release");
    await writeFile(authFile, "{}", "utf8");
    await symlink(authFile, authAlias);
    let active = 0;
    let maximumActive = 0;
    const serveOrder = [];
    let firstStarted;
    const started = new Promise((resolve) => {
      firstStarted = resolve;
    });
    const observe = (label) => (event) => {
      if (event.phase === "started") {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        serveOrder.push(`${label}:started`);
        firstStarted();
      } else {
        active -= 1;
        serveOrder.push(`${label}:exited`);
      }
    };
    const managedAgent = (managedAuthFile = authFile) =>
      agent({
        auth: { mode: "chatgpt", authFile: managedAuthFile },
        env: {
          FAKE_MODE: "barrier-complete",
          FAKE_START_BARRIER: startBarrier,
          FAKE_RELEASE_BARRIER: releaseBarrier,
        },
      });

    const first = managedAgent().generate({
      prompt: "managed first",
      rootDir: directory,
      onProcess: observe("first"),
    });
    await started;
    await waitForLifecycleEntryCount(startBarrier, "managed first", 1);
    const controller = new AbortController();
    const abortReason = new Error("managed waiter aborted");
    const second = managedAgent(authAlias).generate({
      prompt: "managed second",
      rootDir: directory,
      abortSignal: controller.signal,
      onProcess: observe("aborted"),
    });
    await waitForLifecycleEntryCount(lifecycle, "capabilities-close", 2);
    expect(active).toBe(1);
    controller.abort(abortReason);
    await expect(second).rejects.toBe(abortReason);
    const third = managedAgent(authAlias).generate({
      prompt: "managed third",
      rootDir: directory,
      onProcess: observe("third"),
    });
    await waitForLifecycleEntryCount(lifecycle, "capabilities-close", 3);
    expect(active).toBe(1);
    await writeFile(releaseBarrier, "release", "utf8");

    const [firstResult, thirdResult] = await Promise.all([first, third]);
    expect(firstResult.text).toBe("deterministic answer");
    expect(thirdResult.text).toBe("deterministic answer");
    expect(maximumActive).toBe(1);
    expect(active).toBe(0);
    expect(serveOrder).toEqual(["first:started", "first:exited", "third:started", "third:exited"]);
  });

  test("freezes a queued managed-auth symlink before it retargets onto another active file", async () => {
    const firstAuthFile = join(directory, "retarget-auth-first.json");
    const secondAuthFile = join(directory, "retarget-auth-second.json");
    const authAlias = join(directory, "retarget-auth-alias.json");
    const authLifecycle = join(directory, "retarget-auth-lifecycle.jsonl");
    const startBarrier = join(directory, "retarget-auth-starts.log");
    const firstRelease = join(directory, "retarget-auth-first-release");
    const queuedRelease = join(directory, "retarget-auth-queued-release");
    const directRelease = join(directory, "retarget-auth-direct-release");
    await Promise.all([writeFile(firstAuthFile, "{}", "utf8"), writeFile(secondAuthFile, "{}", "utf8")]);
    await symlink(firstAuthFile, authAlias);
    const canonicalFirstAuthFile = await realpath(firstAuthFile);
    const canonicalSecondAuthFile = await realpath(secondAuthFile);
    const managedAgent = (authFile, releaseBarrier) =>
      agent({
        auth: { mode: "chatgpt", authFile },
        env: {
          FAKE_AUTH_LIFECYCLE: authLifecycle,
          FAKE_MODE: "barrier-complete",
          FAKE_START_BARRIER: startBarrier,
          FAKE_RELEASE_BARRIER: releaseBarrier,
        },
      });

    const first = managedAgent(firstAuthFile, firstRelease).generate({
      prompt: "retarget first",
      rootDir: directory,
    });
    await waitForLifecycleEntryCount(startBarrier, "retarget first", 1);

    const queuedController = new AbortController();
    const originalAddEventListener = queuedController.signal.addEventListener.bind(queuedController.signal);
    let abortListenerCount = 0;
    let markQueued;
    const queuedAtGate = new Promise((resolveQueued) => {
      markQueued = resolveQueued;
    });
    queuedController.signal.addEventListener = (type, listener, options) => {
      const result = originalAddEventListener(type, listener, options);
      if (type === "abort" && ++abortListenerCount === 2) markQueued();
      return result;
    };
    const queued = managedAgent(authAlias, queuedRelease).generate({
      prompt: "retarget queued",
      rootDir: directory,
      abortSignal: queuedController.signal,
    });
    await queuedAtGate;

    await rm(authAlias);
    await symlink(secondAuthFile, authAlias);
    const direct = managedAgent(secondAuthFile, directRelease).generate({
      prompt: "retarget direct",
      rootDir: directory,
    });
    await waitForLifecycleEntryCount(startBarrier, "retarget direct", 1);
    await writeFile(firstRelease, "release", "utf8");
    await waitForLifecycleEntryCount(startBarrier, "retarget queued", 1);

    await Promise.all([writeFile(queuedRelease, "release", "utf8"), writeFile(directRelease, "release", "utf8")]);
    const results = await Promise.all([first, queued, direct]);
    expect(results.map((result) => result.text)).toEqual([
      "deterministic answer",
      "deterministic answer",
      "deterministic answer",
    ]);

    const commands = await capturedCommands(capture);
    const authFilesByPrompt = Object.fromEntries(
      commands.map((command) => [command.data.prompt, command.data.auth.authFile]),
    );
    expect(authFilesByPrompt).toEqual({
      "retarget first": canonicalFirstAuthFile,
      "retarget queued": canonicalFirstAuthFile,
      "retarget direct": canonicalSecondAuthFile,
    });

    const activeByAuthFile = new Map();
    const maximumByAuthFile = new Map();
    for (const event of await capturedCommands(authLifecycle)) {
      const active = (activeByAuthFile.get(event.authFile) ?? 0) + (event.phase === "started" ? 1 : -1);
      activeByAuthFile.set(event.authFile, active);
      maximumByAuthFile.set(event.authFile, Math.max(maximumByAuthFile.get(event.authFile) ?? 0, active));
    }
    expect(maximumByAuthFile).toEqual(
      new Map([
        [canonicalFirstAuthFile, 1],
        [canonicalSecondAuthFile, 1],
      ]),
    );
    expect([...activeByAuthFile.values()]).toEqual([0, 0]);
  });

  test("keeps managed-auth turns for different canonical files concurrent", async () => {
    const firstAuthFile = join(directory, "managed-auth-first.json");
    const secondAuthFile = join(directory, "managed-auth-second.json");
    const startBarrier = join(directory, "different-auth-starts.log");
    const releaseBarrier = join(directory, "different-auth-release");
    await Promise.all([writeFile(firstAuthFile, "{}", "utf8"), writeFile(secondAuthFile, "{}", "utf8")]);
    let active = 0;
    let maximumActive = 0;
    const observe = (event) => {
      if (event.phase === "started") {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
      } else {
        active -= 1;
      }
    };
    const managedAgent = (authFile) =>
      agent({
        auth: { mode: "chatgpt", authFile },
        env: {
          FAKE_MODE: "barrier-complete",
          FAKE_START_BARRIER: startBarrier,
          FAKE_RELEASE_BARRIER: releaseBarrier,
        },
      });

    const firstPromise = managedAgent(firstAuthFile).generate({
      prompt: "managed first",
      rootDir: directory,
      onProcess: observe,
    });
    const secondPromise = managedAgent(secondAuthFile).generate({
      prompt: "managed second",
      rootDir: directory,
      onProcess: observe,
    });
    await waitForLifecycleEntryCount(startBarrier, "managed first", 1);
    await waitForLifecycleEntryCount(startBarrier, "managed second", 1);
    expect(maximumActive).toBe(2);
    await writeFile(releaseBarrier, "release", "utf8");
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(first.text).toBe("deterministic answer");
    expect(second.text).toBe("deterministic answer");
    expect(maximumActive).toBe(2);
    expect(active).toBe(0);
  });

  test("keeps API-key turns concurrent across agent instances", async () => {
    const startBarrier = join(directory, "api-key-starts.log");
    const releaseBarrier = join(directory, "api-key-release");
    let active = 0;
    let maximumActive = 0;
    const observe = (event) => {
      if (event.phase === "started") {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
      } else {
        active -= 1;
      }
    };
    const firstPromise = agent({
      env: {
        FAKE_MODE: "barrier-complete",
        FAKE_START_BARRIER: startBarrier,
        FAKE_RELEASE_BARRIER: releaseBarrier,
      },
    }).generate({
      prompt: "api first",
      rootDir: directory,
      onProcess: observe,
    });
    const secondPromise = agent({
      env: {
        FAKE_MODE: "barrier-complete",
        FAKE_START_BARRIER: startBarrier,
        FAKE_RELEASE_BARRIER: releaseBarrier,
      },
    }).generate({
      prompt: "api second",
      rootDir: directory,
      onProcess: observe,
    });
    await waitForLifecycleEntryCount(startBarrier, "api first", 1);
    await waitForLifecycleEntryCount(startBarrier, "api second", 1);
    expect(maximumActive).toBe(2);
    await writeFile(releaseBarrier, "release", "utf8");
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(first.text).toBe("deterministic answer");
    expect(second.text).toBe("deterministic answer");
    expect(maximumActive).toBe(2);
    expect(active).toBe(0);
  });

  test("freezes an ambient managed-auth fallback while the serve process is queued", async () => {
    const firstAuthFile = join(directory, "ambient-auth-first.json");
    const secondAuthFile = join(directory, "ambient-auth-second.json");
    const startBarrier = join(directory, "ambient-auth-starts.log");
    const releaseBarrier = join(directory, "ambient-auth-release");
    const environmentCapture = join(directory, "ambient-auth-environments.jsonl");
    await Promise.all([writeFile(firstAuthFile, "{}", "utf8"), writeFile(secondAuthFile, "{}", "utf8")]);
    const originalAuthFile = process.env.NANOCODEX_AUTH_FILE;
    process.env.NANOCODEX_AUTH_FILE = firstAuthFile;
    const managedAgent = () =>
      new NanocodexAgent({
        binary,
        cwd: directory,
        auth: { mode: "chatgpt" },
        cancellationGraceMs: 200,
        env: {
          FAKE_CAPTURE: capture,
          FAKE_ENV_CAPTURE: environmentCapture,
          FAKE_MODE: "barrier-complete",
          FAKE_START_BARRIER: startBarrier,
          FAKE_RELEASE_BARRIER: releaseBarrier,
        },
      });

    try {
      const first = managedAgent().generate({ prompt: "ambient first", rootDir: directory });
      await waitForLifecycleEntryCount(startBarrier, "ambient first", 1);
      const second = managedAgent().generate({ prompt: "ambient second", rootDir: directory });
      await waitForLifecycleEntryCount(lifecycle, "capabilities-close", 2);
      expect((await readFile(startBarrier, "utf8")).trim().split("\n")).toEqual(["ambient first"]);

      process.env.NANOCODEX_AUTH_FILE = secondAuthFile;
      await writeFile(releaseBarrier, "release", "utf8");
      const results = await Promise.all([first, second]);
      expect(results.map((result) => result.text)).toEqual(["deterministic answer", "deterministic answer"]);
      const environments = (await readFile(environmentCapture, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(environments).toEqual([{ NANOCODEX_AUTH_FILE: firstAuthFile }, { NANOCODEX_AUTH_FILE: firstAuthFile }]);
      expect((await capturedCommands(capture)).map((command) => command.data.auth)).toEqual([
        { mode: "chatgpt", authFile: firstAuthFile },
        { mode: "chatgpt", authFile: firstAuthFile },
      ]);
    } finally {
      if (originalAuthFile === undefined) delete process.env.NANOCODEX_AUTH_FILE;
      else process.env.NANOCODEX_AUTH_FILE = originalAuthFile;
    }
  });

  test("materializes every bridge managed-auth fallback as an explicit absolute wire path", async () => {
    const cases = [
      {
        environment: {
          NANOCODEX_AUTH_FILE: "nanocodex-auth.json",
          CODEX_HOME: join(directory, "ignored-codex-home"),
        },
        expected: join(directory, "nanocodex-auth.json"),
      },
      {
        environment: { CODEX_HOME: join(directory, "codex-home") },
        expected: join(directory, "codex-home", "auth.json"),
      },
      {
        environment: { CODEX_HOME: "", HOME: join(directory, "home") },
        expected: join(directory, "home", ".codex", "auth.json"),
      },
      {
        environment: { USERPROFILE: join(directory, "profile") },
        expected: join(directory, "profile", ".codex", "auth.json"),
      },
    ];

    for (const [index, fallback] of cases.entries()) {
      await agent({ auth: { mode: "chatgpt" }, env: fallback.environment }).generate({
        prompt: `fallback ${index}`,
        rootDir: directory,
      });
    }

    expect((await capturedCommands(capture)).map((command) => command.data.auth)).toEqual(
      cases.map((fallback) => ({ mode: "chatgpt", authFile: fallback.expected })),
    );
  });

  test("uses constructor cwd and then process cwd when no per-call workspace is supplied", async () => {
    await agent().generate({ prompt: "constructor fallback" });
    const direct = new NanocodexAgent({
      binary,
      auth: { mode: "api-key-env", environmentVariable: "FAKE_NANOCODEX_KEY" },
      inheritEnv: false,
      env: { FAKE_NANOCODEX_KEY: "key", FAKE_CAPTURE: capture },
    });
    await direct.generate({ prompt: "process fallback" });
    const commands = await capturedCommands(capture);
    expect(commands[0].data.workspace).toBe(directory);
    expect(commands[1].data.workspace).toBe(process.cwd());
  });

  test("resumes the opaque snapshot in a fresh process and rejects incompatible policy/workspace", async () => {
    const first = await agent().generate({ prompt: "first", rootDir: directory });
    const resumed = await agent().generate({
      prompt: "second",
      rootDir: directory,
      resumeCheckpoint: first.checkpoint,
      checkpointMode: "resume",
    });
    expect(resumed.text).toBe("deterministic answer");
    expect(first.checkpoint.payload.model).toBe("gpt-5.6-sol");
    const commands = await capturedCommands(capture);
    expect(commands).toHaveLength(2);
    expect(commands[0].data.options.model).toBe("gpt-5.6-sol");
    expect(commands[1].data.options.model).toBeUndefined();
    expect(commands[1].data.continuation).toEqual({
      mode: "resume",
      snapshot: first.checkpoint.payload.nanocodexSnapshot,
    });

    const matching = await agent({ model: "sol" }).generate({
      prompt: "matching model",
      rootDir: directory,
      resumeCheckpoint: first.checkpoint,
      checkpointMode: "resume",
    });
    expect(matching.text).toBe("deterministic answer");
    expect((await capturedCommands(capture))[2].data.options.model).toBe("gpt-5.6-sol");
    await expect(
      agent({ model: "gpt-5.6-terra" }).generate({
        prompt: "mismatched model",
        rootDir: directory,
        resumeCheckpoint: first.checkpoint,
        checkpointMode: "resume",
      }),
    ).rejects.toMatchObject({
      code: "AGENT_CHECKPOINT_INVALID",
      details: { bridgeCode: "model_mismatch", failureRetryable: false },
    });

    const modelLess = structuredClone(first.checkpoint);
    delete modelLess.payload.model;
    await agent({ model: "sol" }).generate({
      prompt: "absent model is Sol",
      rootDir: directory,
      resumeCheckpoint: modelLess,
      checkpointMode: "resume",
    });
    const afterAbsentSol = await capturedCommands(capture);
    await expect(
      agent({ model: "terra" }).generate({
        prompt: "absent model rejects Terra",
        rootDir: directory,
        resumeCheckpoint: modelLess,
        checkpointMode: "resume",
      }),
    ).rejects.toMatchObject({
      code: "AGENT_CHECKPOINT_INVALID",
      details: { bridgeCode: "model_mismatch", failureRetryable: false },
    });
    expect(await capturedCommands(capture)).toHaveLength(afterAbsentSol.length);

    await expect(
      agent({ instructions: "different complete instructions" }).generate({
        prompt: "incompatible",
        rootDir: directory,
        resumeCheckpoint: first.checkpoint,
        checkpointMode: "resume",
      }),
    ).rejects.toThrow("policy");
    const otherWorkspace = await mkdtemp(join(tmpdir(), "smithers-nanocodex-other-"));
    try {
      await expect(
        agent().generate({
          prompt: "relocated",
          rootDir: otherWorkspace,
          resumeCheckpoint: first.checkpoint,
          checkpointMode: "resume",
        }),
      ).rejects.toThrow("workspace");
    } finally {
      await rm(otherWorkspace, { recursive: true, force: true });
    }
  });

  test("rejects a 0.0.1 / Nanocodex 0.3.0 envelope before spawn", async () => {
    const rejected = JSON.parse(
      await readFile(new URL("./fixtures/nanocodex/checkpoint-v0.0.1-rejected.json", import.meta.url), "utf8"),
    );
    await expect(
      agent().generate({
        prompt: "old envelope",
        rootDir: directory,
        resumeCheckpoint: rejected,
        checkpointMode: "resume",
      }),
    ).rejects.toMatchObject({ code: "AGENT_CHECKPOINT_INVALID" });
    expect(await readFile(capture, "utf8").catch(() => "")).toBe("");
  });

  test("enforces the runtime continuation discriminant and classifies invalid checkpoints", async () => {
    const first = await agent().generate({ prompt: "first", rootDir: directory });
    await expect(
      agent().generate({ prompt: "missing mode", rootDir: directory, resumeCheckpoint: first.checkpoint }),
    ).rejects.toMatchObject({ code: "AGENT_CONFIG_INVALID" });
    await expect(
      agent().generate({ prompt: "missing checkpoint", rootDir: directory, checkpointMode: "resume" }),
    ).rejects.toMatchObject({ code: "AGENT_CONFIG_INVALID" });
    await expect(
      agent().generate({
        prompt: "null checkpoint",
        rootDir: directory,
        resumeCheckpoint: null,
        checkpointMode: "resume",
      }),
    ).rejects.toMatchObject({ code: "AGENT_CHECKPOINT_INVALID", details: { failureRetryable: false } });
    await expect(
      agent().generate({
        prompt: "unknown mode",
        rootDir: directory,
        resumeCheckpoint: first.checkpoint,
        checkpointMode: "fork",
      }),
    ).rejects.toMatchObject({ code: "AGENT_CONFIG_INVALID" });
    expect(await capturedCommands(capture)).toHaveLength(1);
  });

  test("rejects a completed checkpoint bound to any workspace other than the requested realpath", async () => {
    let publications = 0;
    await expect(
      agent({ env: { FAKE_MODE: "workspace-mismatch" } }).generate({
        prompt: "wrong workspace",
        rootDir: directory,
        onCheckpoint: async () => {
          publications += 1;
        },
      }),
    ).rejects.toMatchObject({
      code: "AGENT_CHECKPOINT_INVALID",
      details: { bridgeCode: "workspace_changed", failureRetryable: false },
    });
    expect(publications).toBe(0);
  });

  test("publishes a recoverable completed boundary before surfacing cleanup failure", async () => {
    const published = [];
    let caught;
    try {
      await agent({ env: { FAKE_MODE: "cleanup-failure" } }).generate({
        prompt: "cleanup",
        rootDir: directory,
        onCheckpoint: async (checkpoint) => published.push(checkpoint),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught?.code).toBe("AGENT_CLI_ERROR");
    expect(caught?.details).toMatchObject({
      bridgeCode: "cleanup_failed",
      retry: "safe",
      failureRetryable: true,
    });
    expect(caught?.checkpoint).toBe(published[0]);
    expect(Object.prototype.propertyIsEnumerable.call(caught, "checkpoint")).toBe(false);
    expect(JSON.stringify(caught)).not.toContain("deterministic answer");
  });

  test("recovers a checkpoint from a non-enumerable cleanup process terminal", async () => {
    const instance = agent();
    const baseline = await instance.generate({ prompt: "baseline", rootDir: directory });
    const snapshotSecret = "CLEANUP_PROCESS_SNAPSHOT_MUST_NOT_SERIALIZE";
    const cleanupError = Object.assign(new Error("cleanup failed"), { code: "bridge_cleanup_failed" });
    Object.defineProperty(cleanupError, "terminal", {
      configurable: true,
      enumerable: false,
      value: {
        type: "turn.completed",
        data: {
          snapshotVersion: 1,
          snapshot: { version: 1, secret: snapshotSecret },
          canonicalWorkspace: directory,
        },
      },
    });
    const published = [];
    const checkpoint = await instance.recoverProcessCheckpoint(cleanupError, {
      args: { onCheckpoint: async (value) => published.push(value) },
      maxCheckpointBytes: 1024 * 1024,
      policyFingerprint: baseline.checkpoint.payload.policyFingerprint,
      workspace: directory,
    });

    expect(checkpoint).toBe(published[0]);
    expect(checkpoint.payload.nanocodexSnapshot.secret).toBe(snapshotSecret);
    expect(JSON.stringify(cleanupError)).not.toContain(snapshotSecret);
  });

  test("maps bridge cleanup failure as non-retryable", () => {
    const processModule = new URL("../internal/nanocodex/process.js", import.meta.url).href;
    const agentModule = new URL("../src/NanocodexAgent.js", import.meta.url).href;
    const script = `
      import { mock } from "bun:test";
      const capabilities = ${JSON.stringify(CAPABILITIES)};
      mock.module(${JSON.stringify(processModule)}, () => ({
        resolveNanocodexExecutable: (command) => command,
        runNanocodexCapabilities: async () => new TextEncoder().encode(JSON.stringify(capabilities)),
        runNanocodexProcess: async () => {
          throw Object.assign(new Error("bridge cleanup failed"), { code: "bridge_cleanup_failed" });
        },
      }));
      const { NanocodexAgent } = await import(${JSON.stringify(`${agentModule}?cleanup-mapping`)});
      try {
        await new NanocodexAgent({
          binary: "/fake/smithers-nanocodex",
          cwd: ${JSON.stringify(directory)},
          auth: { mode: "api-key-env", environmentVariable: "FAKE_KEY" },
          inheritEnv: false,
          env: { FAKE_KEY: "secret" },
        }).generate({ prompt: "cleanup", rootDir: ${JSON.stringify(directory)} });
        process.exitCode = 1;
      } catch (error) {
        process.stdout.write(JSON.stringify({ code: error.code, details: error.details }));
      }
    `;
    const result = spawnSync(Bun.which("bun"), ["--eval", script], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      code: "AGENT_CLI_ERROR",
      details: { bridgeCode: "bridge_cleanup_failed", failureRetryable: false },
    });
  });

  test("publishes an authoritative completion despite a later abnormal bridge exit", async () => {
    for (const mode of ["completion-nonzero", "completion-signal"]) {
      const published = [];
      const result = await agent({ env: { FAKE_MODE: mode } }).generate({
        prompt: mode,
        rootDir: directory,
        onCheckpoint: async (checkpoint) => published.push(checkpoint),
      });
      expect(result.text).toBe("deterministic answer");
      expect(result.checkpoint).toBe(published[0]);
    }
  });

  test("uses the lower constructor/runtime checkpoint ceiling and never publishes on rejection", async () => {
    let publications = 0;
    await expect(
      agent().generate({
        prompt: "too-small checkpoint",
        rootDir: directory,
        maxAgentCheckpointBytes: 100,
        onCheckpoint: async () => {
          publications += 1;
        },
      }),
    ).rejects.toThrow("checkpoint");
    expect(publications).toBe(0);

    await expect(
      agent({ maxCheckpointBytes: 100 }).generate({
        prompt: "constructor ceiling is lower",
        rootDir: directory,
        maxAgentCheckpointBytes: 1024 * 1024,
        onCheckpoint: async () => {
          publications += 1;
        },
      }),
    ).rejects.toThrow("checkpoint");
    expect(publications).toBe(0);
  });

  test("accepts a realistic nested Unicode snapshot at its exact encoded checkpoint boundary", async () => {
    const first = await agent({ env: { FAKE_MODE: "large-checkpoint" } }).generate({
      prompt: "large checkpoint",
      rootDir: directory,
    });
    const exactBytes = Buffer.byteLength(JSON.stringify(first.checkpoint), "utf8");
    expect(exactBytes).toBeGreaterThan(500_000);

    const exact = await agent({ env: { FAKE_MODE: "large-checkpoint" }, maxCheckpointBytes: exactBytes }).generate({
      prompt: "exact boundary",
      rootDir: directory,
    });
    expect(Buffer.byteLength(JSON.stringify(exact.checkpoint), "utf8")).toBe(exactBytes);
    await expect(
      agent({ env: { FAKE_MODE: "large-checkpoint" }, maxCheckpointBytes: exactBytes - 1 }).generate({
        prompt: "one byte over",
        rootDir: directory,
      }),
    ).rejects.toMatchObject({ code: "AGENT_CHECKPOINT_INVALID", details: { failureRetryable: false } });
  });

  test("preserves checkpoint durability-fence rejection exactly", async () => {
    const ownershipLost = new Error("checkpoint ownership lost");
    await expect(
      agent().generate({
        prompt: "publication fence",
        rootDir: directory,
        onCheckpoint: async () => {
          throw ownershipLost;
        },
      }),
    ).rejects.toBe(ownershipLost);
  });

  test("preserves checkpoint rejection when the callback also aborts", async () => {
    const controller = new AbortController();
    const abortReason = new Error("abort must not replace publication rejection");
    const ownershipLost = new Error("checkpoint ownership lost during abort");
    await expect(
      agent().generate({
        prompt: "publication fence abort",
        rootDir: directory,
        abortSignal: controller.signal,
        onCheckpoint: async () => {
          controller.abort(abortReason);
          throw ownershipLost;
        },
      }),
    ).rejects.toBe(ownershipLost);
  });

  test("sends one exact correlated cancellation and preserves the caller abort reason", async () => {
    const controller = new AbortController();
    const reason = new Error("caller stopped this turn");
    const events = [];
    const promise = agent({ env: { FAKE_MODE: "wait" } }).generate({
      prompt: "wait",
      rootDir: directory,
      abortSignal: controller.signal,
      onEvent: (event) => {
        events.push(event);
        if (event.type === "started") controller.abort(reason);
      },
    });
    await expect(promise).rejects.toBe(reason);
    const commands = await capturedCommands(capture);
    expect(commands.map((command) => command.type)).toEqual(["turn.start", "turn.cancel"]);
    expect(commands[1].requestId).toBe(commands[0].requestId);
    expect(commands[1].sessionId).toBe("fake-session");
    expect(events.some((event) => event.type === "completed" && !event.ok)).toBe(true);
  });

  test("queues a confidential request-correlated cancellation before turn acceptance", async () => {
    const controller = new AbortController();
    const reason = new Error("caller cancelled before acceptance");
    const prompt = "PROMPT_MUST_NOT_APPEAR_IN_CANCEL";
    const promise = agent({ env: { FAKE_MODE: "defer-accept" } }).generate({
      prompt,
      rootDir: directory,
      abortSignal: controller.signal,
    });
    await waitForCapturedCommand(capture, "turn.start");
    controller.abort(reason);
    await expect(promise).rejects.toBe(reason);

    const commands = await capturedCommands(capture);
    expect(commands.map((command) => command.type)).toEqual(["turn.start", "turn.cancel"]);
    expect(commands[1].requestId).toBe(commands[0].requestId);
    expect(commands[1]).not.toHaveProperty("sessionId");
    expect(JSON.stringify(commands[1])).not.toContain(prompt);
    expect(JSON.stringify(commands[1])).not.toContain("snapshot");
  });

  test("does not persist untrusted bridge cancellation text", async () => {
    const secretReason = "BRIDGE_CANCEL_REASON_MUST_NOT_PERSIST";
    let caught;
    try {
      await agent({ env: { FAKE_MODE: "bridge-cancelled", FAKE_CANCEL_REASON: secretReason } }).generate({
        prompt: "cancelled by bridge",
        rootDir: directory,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: "AGENT_CLI_ERROR",
      details: { bridgeCode: "turn_cancelled" },
    });
    expect(JSON.stringify(caught)).not.toContain(secretReason);
  });

  test("preserves authoritative retry-after metadata for authentication failures", async () => {
    await expect(
      agent({ env: { FAKE_MODE: "auth-retry" } }).generate({ prompt: "retry auth", rootDir: directory }),
    ).rejects.toMatchObject({
      code: "AGENT_CONFIG_INVALID",
      details: {
        bridgeCode: "auth_temporarily_unavailable",
        bridgeCategory: "auth",
        retry: "after",
        retryAfterMs: 2_750,
        failureRetryable: true,
      },
    });
  });

  test.skipIf(process.platform !== "linux")("rejects unsupported libc before any bridge process starts", async () => {
    const original = process.report.getReport;
    process.report.getReport = () => ({ header: { glibcVersionRuntime: "2.34" } });
    try {
      await expect(agent().preflight({ rootDir: directory })).rejects.toMatchObject({ code: "AGENT_CONFIG_INVALID" });
      expect(await readFile(lifecycle, "utf8").catch(() => "")).toBe("");
    } finally {
      process.report.getReport = original;
    }
  });

  test("rejects unshipped hosts before any bridge process starts", async () => {
    const originalPlatform = process.platform;
    const originalArch = process.arch;
    try {
      for (const [platform, arch] of [
        ["darwin", "x64"],
        ["linux", "arm64"],
        ["win32", "x64"],
      ]) {
        process.platform = platform;
        process.arch = arch;
        await expect(agent().preflight({ rootDir: directory })).rejects.toMatchObject({
          code: "AGENT_CONFIG_INVALID",
        });
      }
      expect(await readFile(lifecycle, "utf8").catch(() => "")).toBe("");
    } finally {
      process.platform = originalPlatform;
      process.arch = originalArch;
    }
  });

  test("accepts macOS arm64 at the host gate", async () => {
    const originalPlatform = process.platform;
    const originalArch = process.arch;
    try {
      process.platform = "darwin";
      process.arch = "arm64";
      const pending = agent().preflight({ rootDir: directory });
      if (HOST_TARGET === "aarch64-apple-darwin") {
        await expect(pending).resolves.toBeUndefined();
      } else {
        // Fake capabilities still report this host's compiled target, so the
        // later target check fails. The host gate itself must have passed.
        await expect(pending).rejects.toMatchObject({ code: "AGENT_CONFIG_INVALID" });
      }
      expect((await readFile(lifecycle, "utf8")).trim().split("\n")).toEqual([
        "capabilities-start",
        "capabilities-close",
      ]);
    } finally {
      process.platform = originalPlatform;
      process.arch = originalArch;
    }
  });

  test("surfaces replacement-instruction and managed-auth path limits as public configuration errors", async () => {
    expect(() => new NanocodexAgent({ instructions: "x".repeat(4 * 1024 * 1024 + 1) })).toThrow(
      expect.objectContaining({ code: "AGENT_CONFIG_INVALID" }),
    );
    expect(() => new NanocodexAgent({ instructions: "\ud800" })).toThrow(
      expect.objectContaining({ code: "AGENT_CONFIG_INVALID" }),
    );
    expect(() => new NanocodexAgent({ auth: { mode: "chatgpt", authFile: `/${"x".repeat(4_096)}` } })).toThrow(
      expect.objectContaining({ code: "AGENT_CONFIG_INVALID" }),
    );

    for (const authFile of [`/${"secret-auth-segment-".repeat(300)}`, "/\ud800"]) {
      const error = await agent({
        auth: { mode: "chatgpt" },
        env: { NANOCODEX_AUTH_FILE: authFile },
      })
        .generate({ prompt: "invalid fallback auth path", rootDir: directory })
        .catch((cause) => cause);
      expect(error).toMatchObject({ code: "AGENT_CONFIG_INVALID" });
      expect(JSON.stringify(errorToJson(error))).not.toContain(authFile);
    }
    expect(await readFile(lifecycle, "utf8").catch(() => "")).toBe("");
  });

  test("maps total and idle timeout precedence through the adapter", async () => {
    await expect(
      agent({ env: { FAKE_MODE: "wait" }, timeoutMs: 20, idleTimeoutMs: 1_000 }).generate({
        prompt: "total timeout",
        rootDir: directory,
      }),
    ).rejects.toMatchObject({ code: "AGENT_CLI_ERROR", details: { bridgeCode: "bridge_timeout" } });
    await expect(
      agent({ env: { FAKE_MODE: "wait" }, timeoutMs: 1_000, idleTimeoutMs: 20 }).generate({
        prompt: "idle timeout",
        rootDir: directory,
      }),
    ).rejects.toMatchObject({ code: "AGENT_CLI_ERROR", details: { bridgeCode: "bridge_idle_timeout" } });
  });

  test("fails closed on unsupported outer features", async () => {
    expect(() => new NanocodexAgent({ endpoint: "https://example.test" })).toThrow("unsupported field");
    expect(() => new NanocodexAgent({ thinking: "unbounded" })).toThrow("thinking level");
    expect(
      () =>
        new NanocodexAgent({ auth: { mode: "api-key-env", environmentVariable: "OPENAI_API_KEY", value: "secret" } }),
    ).toThrow("unsupported field");
    const instance = agent();
    await expect(instance.generate({ prompt: "x", rootDir: directory, resumeSession: "legacy" })).rejects.toThrow(
      "checkpoints",
    );
    await expect(instance.generate({ prompt: "x", rootDir: directory, tools: {} })).rejects.toThrow("JavaScript tools");
    await expect(
      instance.generate({
        messages: [
          { role: "system", content: "hidden override" },
          { role: "user", content: "x" },
        ],
        rootDir: directory,
      }),
    ).rejects.toThrow("system messages");
  });

  test("rejects malformed abort signals before starting a bridge", async () => {
    await expect(
      agent().generate({ prompt: "invalid signal", rootDir: directory, abortSignal: { aborted: false } }),
    ).rejects.toMatchObject({ code: "AGENT_CONFIG_INVALID" });
    expect(await readFile(capture, "utf8").catch(() => "")).toBe("");
  });

  test("rejects timer options above the JavaScript timeout ceiling", async () => {
    const overflow = 2 ** 31;
    for (const name of ["timeoutMs", "idleTimeoutMs", "cancellationGraceMs"]) {
      expect(() => new NanocodexAgent({ [name]: overflow })).toThrow(String(2 ** 31 - 1));
    }
    expect(() => new NanocodexAgent({ timeoutMs: 2 ** 31 - 1 })).not.toThrow();
    await expect(
      agent().generate({ prompt: "overflow", rootDir: directory, timeout: { totalMs: overflow } }),
    ).rejects.toMatchObject({ code: "AGENT_CONFIG_INVALID" });
    expect(await readFile(capture, "utf8").catch(() => "")).toBe("");
  });
});

async function capturedCommands(path) {
  const text = await readFile(path, "utf8");
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function waitForCapturedCommand(path, type) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const commands = await capturedCommands(path).catch(() => []);
    if (commands.some((command) => command.type === type)) return;
    await Bun.sleep(5);
  }
  throw new Error(`Timed out waiting for captured ${type} command.`);
}

async function waitForLifecycleEntryCount(path, value, count) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const text = await readFile(path, "utf8").catch(() => "");
    if (
      text
        .trim()
        .split("\n")
        .filter((entry) => entry === value).length >= count
    )
      return;
    await Bun.sleep(5);
  }
  throw new Error(`Timed out waiting for ${count} ${value} lifecycle entries.`);
}

function fakeBridgeSource(lifecycle, recordMissingPath = false) {
  return `#!${process.execPath}
import { appendFileSync, existsSync, realpathSync } from "node:fs";
import { createInterface } from "node:readline";
const capabilities = ${JSON.stringify(CAPABILITIES)};
if (process.argv[2] === "capabilities") {
  appendFileSync(${JSON.stringify(lifecycle)}, "capabilities-start\\n");
  ${recordMissingPath ? `if (process.env.PATH === undefined) appendFileSync(${JSON.stringify(lifecycle)}, "capabilities-path-absent\\n");` : ""}
  process.stdout.write(JSON.stringify(capabilities) + "\\n", () => {
    setTimeout(() => appendFileSync(${JSON.stringify(lifecycle)}, "capabilities-close\\n"), 20);
  });
} else if (process.argv[2] === "serve") {
  appendFileSync(${JSON.stringify(lifecycle)}, "serve-start\\n");
  if (process.env.FAKE_ENV_CAPTURE) {
    appendFileSync(process.env.FAKE_ENV_CAPTURE, JSON.stringify({
      NANOCODEX_AUTH_FILE: process.env.NANOCODEX_AUTH_FILE,
    }) + "\\n");
  }
  let seq = 1;
  let requestId;
  let pendingStart;
  let managedAuthLifecycle;
  const recordManagedAuthStart = (command) => {
    if (!process.env.FAKE_AUTH_LIFECYCLE || command.data.auth.mode !== "chatgpt") return;
    let authFile = command.data.auth.authFile;
    try { authFile = realpathSync(authFile); } catch {}
    managedAuthLifecycle = { authFile, prompt: command.data.prompt };
    appendFileSync(process.env.FAKE_AUTH_LIFECYCLE, JSON.stringify({
      phase: "started", ...managedAuthLifecycle,
    }) + "\\n");
  };
  const recordManagedAuthEnd = () => {
    if (!process.env.FAKE_AUTH_LIFECYCLE || !managedAuthLifecycle) return;
    appendFileSync(process.env.FAKE_AUTH_LIFECYCLE, JSON.stringify({
      phase: "exited", ...managedAuthLifecycle,
    }) + "\\n");
  };
  const write = (type, data, correlation = {}) => process.stdout.write(JSON.stringify({
    protocol: "smithers.nanocodex", version: 1, type, seq: seq++, ...correlation, data,
  }) + "\\n");
  const exitSoon = () => setTimeout(() => process.exit(process.exitCode ?? 0), 5);
  const signalSoon = () => setTimeout(() => process.kill(process.pid, "SIGKILL"), 5);
  const completed = (workspace, command) => ({
    finalMessage: "deterministic answer",
    usage: {
      inputTokens: 11, cachedInputTokens: 3, cacheWriteInputTokens: 2,
      outputTokens: 7, reasoningOutputTokens: 2, totalTokens: 18,
      estimatedUsd: "0.001", costStatus: "estimated_from_usage", serviceTier: "standard",
    },
    model: command?.data?.options?.model ?? "gpt-5.6-sol",
    snapshotVersion: 1,
    snapshot: { version: 1, workspace, history: [{ role: "assistant", content: "deterministic answer" }] },
    canonicalWorkspace: workspace,
  });
  write("hello", capabilities);
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    const command = JSON.parse(line);
    appendFileSync(process.env.FAKE_CAPTURE, JSON.stringify(command) + "\\n");
    if (command.type === "turn.start") {
      requestId = command.requestId;
      recordManagedAuthStart(command);
      if (process.env.FAKE_START_BARRIER) {
        appendFileSync(process.env.FAKE_START_BARRIER, command.data.prompt + "\\n");
      }
      if (process.env.FAKE_MODE === "defer-accept") {
        pendingStart = command;
        return;
      }
      const correlation = { requestId, commandId: command.commandId, sessionId: "fake-session" };
      write("turn.accepted", {}, correlation);
      if (process.env.FAKE_MODE === "wait") return;
      if (process.env.FAKE_MODE === "bridge-cancelled") {
        write("turn.cancelled", { reason: process.env.FAKE_CANCEL_REASON }, {
          requestId, sessionId: "fake-session",
        });
        process.exitCode = 130;
        lines.close();
        exitSoon();
        return;
      }
      if (process.env.FAKE_MODE === "auth-retry") {
        write("turn.failed", {
          error: {
            code: "auth_temporarily_unavailable", category: "auth",
            message: "Retry authentication later.", retry: "after", retryAfterMs: 2750,
          },
        }, { requestId, sessionId: "fake-session" });
        process.exitCode = 3;
        lines.close();
        exitSoon();
        return;
      }
      if (process.env.FAKE_MODE === "barrier-complete") {
        const completeAfterRelease = () => {
          if (!existsSync(process.env.FAKE_RELEASE_BARRIER)) {
            setTimeout(completeAfterRelease, 5);
            return;
          }
          recordManagedAuthEnd();
          write("turn.completed", completed(command.data.workspace, command), {
            requestId, sessionId: "fake-session",
          });
          lines.close();
          exitSoon();
        };
        completeAfterRelease();
        return;
      }
      write("agent.event", { event: {
        upstreamSeq: 1, type: "assistant.delta",
        payload: { modelCallIndex: 0, itemId: null, phase: "commentary", text: "deterministic " },
      } }, { requestId, sessionId: "fake-session" });
      write("agent.event", { event: {
        upstreamSeq: 2, type: "tool.call",
        payload: {
          callId: "tool-1", tool: "exec_command",
          modelCallIndex: 1,
        },
      } }, { requestId, sessionId: "fake-session" });
      write("agent.event", { event: {
        upstreamSeq: 3, type: "tool.result",
        payload: {
          callId: "tool-1", tool: "exec_command", status: "completed",
          durationNs: 10, startedAfterNs: null,
        },
      } }, { requestId, sessionId: "fake-session" });
      const result = completed(command.data.workspace, command);
      if (process.env.FAKE_MODE === "large-checkpoint") {
        result.snapshot = { version: 1, nested: { unicode: "🙂".repeat(130000) } };
      }
      if (process.env.FAKE_MODE === "workspace-mismatch") result.canonicalWorkspace = "/tmp";
      if (process.env.FAKE_MODE === "cleanup-failure") {
        write("turn.failed", {
          error: { code: "cleanup_failed", category: "cleanup", message: "Cleanup failed.", retry: "safe" },
          completed: {
            model: result.model,
            snapshotVersion: result.snapshotVersion,
            snapshot: result.snapshot,
            canonicalWorkspace: result.canonicalWorkspace,
          },
        }, { requestId, sessionId: "fake-session" });
        process.exitCode = 5;
      } else {
        write("turn.completed", result, { requestId, sessionId: "fake-session" });
        if (process.env.FAKE_MODE === "completion-nonzero") process.exitCode = 9;
      }
      lines.close();
      if (process.env.FAKE_MODE === "completion-signal") signalSoon();
      else exitSoon();
    } else if (command.type === "turn.cancel" && pendingStart) {
      write("command.accepted", { command: "turn.cancel" }, {
        requestId, commandId: command.commandId,
      });
      write("turn.accepted", {}, {
        requestId, commandId: pendingStart.commandId, sessionId: "fake-session",
      });
      write("turn.cancelled", { reason: "cancelled" }, { requestId, sessionId: "fake-session" });
      process.exitCode = 130;
      lines.close();
      exitSoon();
    } else if (command.type === "turn.cancel") {
      write("command.accepted", { command: "turn.cancel" }, {
        requestId, commandId: command.commandId, sessionId: "fake-session",
      });
      write("turn.cancelled", { reason: "cancelled" }, { requestId, sessionId: "fake-session" });
      process.exitCode = 130;
      lines.close();
      exitSoon();
    }
  });
} else {
  process.exitCode = 2;
}
`;
}
