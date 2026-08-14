import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_AGENT_CHECKPOINT_MAX_BYTES, NanocodexAgent } from "@smthrs/agents";
import { SmithersDb } from "@smthrs/db/adapter";
import { replayFromCheckpoint } from "@smthrs/time-travel/replay";
import { loadLatestSnapshot } from "@smthrs/time-travel/snapshot";
import { Effect } from "effect";
import { z } from "zod";
import { runWorkflow, Task, Workflow } from "smthrs";
import { jsx } from "smthrs/jsx-runtime";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { nanocodexHostTarget, nanocodexTestSupported } from "./nanocodex-host-support.js";

const CONFIGURED_CHECKPOINT_LIMIT = 4_096;
const nTest = nanocodexTestSupported ? test : test.skip;

const NANOCODEX_CAPABILITIES = {
  bridgeVersion: "0.0.2",
  target: nanocodexHostTarget,
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
    maxJsonKeyBytes: 1024,
    maxManagedAuthFileBytes: 1024 * 1024,
  },
};

describe("agent checkpoint limit propagation", () => {
  test("passes the configured limit to preflight, initial generation, and correction turns", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers({
      result: z.object({ value: z.number() }),
    });
    const preflightCalls = [];
    const generateCalls = [];
    const agent = {
      id: "checkpoint-limit-recorder",
      tools: {},
      async preflight(options) {
        preflightCalls.push(options);
      },
      async generate(options) {
        generateCalls.push(options);
        if (generateCalls.length === 1) return { text: "not-json" };
        return generateCalls.length === 2 ? { text: '{"value":"invalid"}' } : { text: '{"value":42}' };
      },
    };

    try {
      const workflow = smithers(() =>
        jsx(Workflow, {
          name: "agent-checkpoint-limit-propagation",
          children: jsx(Task, {
            id: "work",
            output: outputs.result,
            agent,
            noRetry: true,
            maxSchemaRetries: 2,
            children: "Return a numeric value",
          }),
        }),
      );

      const result = await Effect.runPromise(
        runWorkflow(workflow, {
          input: {},
          maxAgentCheckpointBytes: CONFIGURED_CHECKPOINT_LIMIT,
        }),
      );

      expect(result.status).toBe("finished");
      expect(preflightCalls).toHaveLength(1);
      expect(preflightCalls[0]).toMatchObject({
        maxAgentCheckpointBytes: CONFIGURED_CHECKPOINT_LIMIT,
        taskContext: { nodeId: "work", iteration: 0, attempt: 1 },
      });
      expect(generateCalls).toHaveLength(3);
      for (const call of generateCalls) {
        expect(call).toMatchObject({
          maxAgentCheckpointBytes: CONFIGURED_CHECKPOINT_LIMIT,
          taskContext: { nodeId: "work", iteration: 0, attempt: 1 },
        });
      }
      expect(generateCalls[0].prompt).toContain("Return a numeric value");
      expect(generateCalls[1].prompt).toContain("valid JSON object");
      expect(generateCalls[2].messages.at(-1)).toMatchObject({
        role: "user",
        content: expect.stringContaining("Your output didn't match the required schema"),
      });
    } finally {
      cleanup();
    }
  }, 30_000);

  test("passes the system ceiling when the run does not lower it", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers({
      result: z.object({ value: z.number() }),
    });
    const preflightCalls = [];
    const generateCalls = [];
    const agent = {
      id: "default-checkpoint-limit-recorder",
      tools: {},
      async preflight(options) {
        preflightCalls.push(options);
      },
      async generate(options) {
        generateCalls.push(options);
        return { text: '{"value":42}' };
      },
    };

    try {
      const workflow = smithers(() =>
        jsx(Workflow, {
          name: "default-agent-checkpoint-limit-propagation",
          children: jsx(Task, {
            id: "work",
            output: outputs.result,
            agent,
            noRetry: true,
            children: "Return a numeric value",
          }),
        }),
      );

      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));

      expect(result.status).toBe("finished");
      expect(preflightCalls).toHaveLength(1);
      expect(preflightCalls[0].maxAgentCheckpointBytes).toBe(DEFAULT_AGENT_CHECKPOINT_MAX_BYTES);
      expect(generateCalls).toHaveLength(1);
      expect(generateCalls[0].maxAgentCheckpointBytes).toBe(DEFAULT_AGENT_CHECKPOINT_MAX_BYTES);
    } finally {
      cleanup();
    }
  }, 30_000);

  test("a Nanocodex-style started event cannot create a legacy CLI-session checkpoint", async () => {
    const { smithers, outputs, db, cleanup } = createTestSmithers({
      result: z.object({ value: z.number() }),
    });
    const checkpoint = {
      codec: "nanocodex.session-snapshot",
      version: 1,
      payload: { opaque: "snapshot" },
    };
    const agent = {
      id: "nanocodex-checkpoint-shape",
      checkpointFormats: [{ codec: checkpoint.codec, versions: [checkpoint.version] }],
      checkpointCapabilities: [{ codec: checkpoint.codec, versions: [checkpoint.version], modes: ["resume"] }],
      async generate(options) {
        await options.onEvent?.({ type: "started", engine: "nanocodex", title: "Nanocodex turn" });
        await options.onCheckpoint?.(checkpoint);
        return { text: '{"value":42}', checkpoint };
      },
    };

    try {
      const workflow = smithers(() =>
        jsx(Workflow, {
          name: "nanocodex-no-legacy-checkpoint",
          children: jsx(Task, {
            id: "work",
            output: outputs.result,
            agent,
            noRetry: true,
            children: "Return a numeric value",
          }),
        }),
      );
      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
      expect(result.status).toBe("finished");
      const rows = db.$client.query("SELECT codec, purpose FROM _smithers_agent_checkpoints ORDER BY sequence").all();
      // Publishing mid-turn (onCheckpoint) and returning the same checkpoint
      // is the Nanocodex adapter's shape, and the substrate records both a
      // `progress` and a `turn` ref for it. Every row must still be the
      // agent's own codec — a `started` event must never synthesize the
      // legacy CLI-session checkpoint.
      expect(rows.map((row) => row.purpose)).toEqual(["progress", "turn"]);
      expect(rows.every((row) => row.codec === "nanocodex.session-snapshot")).toBe(true);
      expect(rows.some((row) => row.codec === "smithers.cli-session")).toBe(false);
    } finally {
      cleanup();
    }
  }, 30_000);

  nTest(
    "runs a normal Nanocodex workflow and preserves its same-workspace checkpoint across replay",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "smithers-nanocodex-normal-"));
      const binary = join(directory, "fake-nanocodex-normal.mjs");
      const capture = join(directory, "captures.jsonl");
      const state = join(directory, "state.txt");
      await writeFile(binary, nanocodexCorrectionBridgeSource(), "utf8");
      await chmod(binary, 0o755);
      const { smithers, outputs, db, cleanup } = createTestSmithers({
        result: z.object({ value: z.number() }),
      });
      const adapter = new SmithersDb(db);
      const agent = new NanocodexAgent({
        binary,
        auth: { mode: "api-key-env", environmentVariable: "FAKE_NANOCODEX_KEY" },
        inheritEnv: false,
        env: {
          FAKE_NANOCODEX_KEY: "never-on-the-wire",
          FAKE_CAPTURE: capture,
          FAKE_STATE: state,
          FAKE_SCENARIO: "normal",
        },
      });
      const workflow = smithers(() =>
        jsx(Workflow, {
          name: "nanocodex-normal-replay",
          children: jsx(Task, {
            id: "work",
            output: outputs.result,
            agent,
            noRetry: true,
            maxSchemaRetries: 0,
            children: "Return a numeric value",
          }),
        }),
      );
      const parentRunId = "nanocodex-normal-replay-parent";

      try {
        const first = await Effect.runPromise(
          runWorkflow(workflow, { input: {}, runId: parentRunId, rootDir: directory }),
        );
        expect(first.status).toBe("finished");
        const captures = (await readFile(capture, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(captures).toHaveLength(1);
        expect(captures[0].command.data.continuation).toBeNull();
        expect(captures[0].command.data.workspace).toBe(await realpath(directory));

        const parentSnapshot = await loadLatestSnapshot(adapter, parentRunId);
        expect(parentSnapshot).toBeDefined();
        const replay = await replayFromCheckpoint(adapter, {
          parentRunId,
          frameNo: parentSnapshot.frameNo,
        });
        const resumed = await Effect.runPromise(
          runWorkflow(workflow, { input: {}, runId: replay.runId, resume: true, rootDir: directory }),
        );
        expect(resumed.status).toBe("finished");
        // The completed task is inherited, so replay must not invoke another
        // bridge or relocate the canonical workspace-bound snapshot.
        expect((await readFile(capture, "utf8")).trim().split("\n")).toHaveLength(1);

        const rows = db.$client
          .query(
            `SELECT refs.run_id, refs.content_hash, contents.checkpoint_json
                  FROM _smithers_agent_checkpoints refs
                  JOIN _smithers_agent_checkpoint_contents contents
                    ON contents.content_hash = refs.content_hash
                 WHERE refs.run_id IN (?, ?)
                   AND refs.purpose = 'progress'
                 ORDER BY refs.run_id`,
          )
          .all(parentRunId, replay.runId);
        // Each turn publishes mid-turn through `onCheckpoint` and returns the
        // same checkpoint, so the substrate holds a `progress` and a `turn` ref
        // per turn. The progress refs are the one-per-turn durable lineage.
        expect(rows).toHaveLength(2);
        expect(new Set(rows.map((row) => row.content_hash)).size).toBe(1);
        for (const row of rows) {
          const checkpoint = JSON.parse(row.checkpoint_json);
          expect(checkpoint.payload.canonicalWorkspace).toBe(await realpath(directory));
          expect(checkpoint.payload.nanocodexSnapshot).toEqual({ version: 1, turns: [1] });
        }
      } finally {
        cleanup();
        await rm(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );

  nTest(
    "runs Nanocodex JSON and schema corrections in fresh bridges from exact durable checkpoints",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "smithers-nanocodex-engine-"));
      const binary = join(directory, "fake-nanocodex-engine.mjs");
      const capture = join(directory, "captures.jsonl");
      const state = join(directory, "state.txt");
      await writeFile(binary, nanocodexCorrectionBridgeSource(), "utf8");
      await chmod(binary, 0o755);

      const { smithers, outputs, db, cleanup } = createTestSmithers({
        result: z.object({ value: z.number() }),
      });
      const agent = new NanocodexAgent({
        binary,
        auth: { mode: "api-key-env", environmentVariable: "FAKE_NANOCODEX_KEY" },
        inheritEnv: false,
        env: {
          FAKE_NANOCODEX_KEY: "never-on-the-wire",
          FAKE_CAPTURE: capture,
          FAKE_STATE: state,
        },
      });

      try {
        const workflow = smithers(() =>
          jsx(Workflow, {
            name: "nanocodex-correction-resume",
            children: jsx(Task, {
              id: "work",
              output: outputs.result,
              agent,
              noRetry: true,
              maxSchemaRetries: 2,
              children: "Return a numeric value",
            }),
          }),
        );
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("finished");

        const captures = (await readFile(capture, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(captures).toHaveLength(3);
        expect(new Set(captures.map((entry) => entry.instance)).size).toBe(3);
        expect(captures.map((entry) => entry.command.data.continuation)).toEqual([
          null,
          { mode: "resume", snapshot: { version: 1, turns: [1] } },
          { mode: "resume", snapshot: { version: 1, turns: [1, 2] } },
        ]);
        expect(captures[0].command.data.prompt).toContain("Return a numeric value");
        expect(captures[1].command.data.prompt).toContain("valid JSON object");
        expect(captures[2].command.data.prompt).toContain("required schema");
        expect(JSON.stringify(captures)).not.toContain("never-on-the-wire");

        const rows = db.$client
          .query(
            `SELECT contents.checkpoint_json
                FROM _smithers_agent_checkpoints refs
                JOIN _smithers_agent_checkpoint_contents contents
                  ON contents.content_hash = refs.content_hash
               WHERE refs.purpose = 'progress'
                ORDER BY refs.sequence`,
          )
          .all();
        // One `progress` ref per correction turn; each turn also stores a
        // byte-identical `turn` ref that is not part of this lineage.
        expect(rows).toHaveLength(3);
        expect(JSON.parse(rows.at(-1).checkpoint_json).payload.nanocodexSnapshot).toEqual({
          version: 1,
          turns: [1, 2, 3],
        });
      } finally {
        cleanup();
        await rm(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );

  nTest(
    "retries after forced bridge death from the exact prior durable Nanocodex snapshot",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "smithers-nanocodex-retry-"));
      const binary = join(directory, "fake-nanocodex-retry.mjs");
      const capture = join(directory, "captures.jsonl");
      const state = join(directory, "state.txt");
      await writeFile(binary, nanocodexCorrectionBridgeSource(), "utf8");
      await chmod(binary, 0o755);
      const { smithers, outputs, cleanup } = createTestSmithers({
        result: z.object({ value: z.number() }),
      });
      const agent = new NanocodexAgent({
        binary,
        auth: { mode: "api-key-env", environmentVariable: "FAKE_NANOCODEX_KEY" },
        inheritEnv: false,
        env: {
          FAKE_NANOCODEX_KEY: "never-on-the-wire",
          FAKE_CAPTURE: capture,
          FAKE_STATE: state,
          FAKE_SCENARIO: "crash-retry",
        },
      });

      try {
        const workflow = smithers(() =>
          jsx(Workflow, {
            name: "nanocodex-forced-death-retry",
            children: jsx(Task, {
              id: "work",
              output: outputs.result,
              agent,
              retries: 1,
              maxSchemaRetries: 1,
              retryPolicy: { backoff: "fixed", initialDelayMs: 0 },
              children: "Return a numeric value",
            }),
          }),
        );
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("finished");
        const captures = (await readFile(capture, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(captures).toHaveLength(3);
        expect(new Set(captures.map((entry) => entry.instance)).size).toBe(3);
        const durableSnapshot = { version: 1, turns: [1] };
        expect(captures.map((entry) => entry.command.data.continuation)).toEqual([
          null,
          { mode: "resume", snapshot: durableSnapshot },
          { mode: "resume", snapshot: durableSnapshot },
        ]);
      } finally {
        cleanup();
        await rm(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );

  nTest(
    "durably publishes cleanup-failed completion before retrying from that Nanocodex snapshot",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "smithers-nanocodex-cleanup-"));
      const binary = join(directory, "fake-nanocodex-cleanup.mjs");
      const capture = join(directory, "captures.jsonl");
      const state = join(directory, "state.txt");
      await writeFile(binary, nanocodexCorrectionBridgeSource(), "utf8");
      await chmod(binary, 0o755);
      const { smithers, outputs, cleanup } = createTestSmithers({
        result: z.object({ value: z.number() }),
      });
      const agent = new NanocodexAgent({
        binary,
        auth: { mode: "api-key-env", environmentVariable: "FAKE_NANOCODEX_KEY" },
        inheritEnv: false,
        env: {
          FAKE_NANOCODEX_KEY: "never-on-the-wire",
          FAKE_CAPTURE: capture,
          FAKE_STATE: state,
          FAKE_SCENARIO: "cleanup-retry",
        },
      });

      try {
        const workflow = smithers(() =>
          jsx(Workflow, {
            name: "nanocodex-cleanup-retry",
            children: jsx(Task, {
              id: "work",
              output: outputs.result,
              agent,
              retries: 1,
              retryPolicy: { backoff: "fixed", initialDelayMs: 0 },
              children: "Return a numeric value",
            }),
          }),
        );
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("finished");
        const captures = (await readFile(capture, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(captures).toHaveLength(2);
        expect(captures[0].command.data.continuation).toBeNull();
        expect(captures[1].command.data.continuation).toEqual({
          mode: "resume",
          snapshot: { version: 1, turns: [1] },
        });
      } finally {
        cleanup();
        await rm(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );
});

function nanocodexCorrectionBridgeSource() {
  return `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
const capabilities = ${JSON.stringify(NANOCODEX_CAPABILITIES)};
if (process.argv[2] === "capabilities") {
  process.stdout.write(JSON.stringify(capabilities) + "\\n");
} else if (process.argv[2] === "serve") {
  let seq = 1;
  const emit = (type, data, correlation = {}) => process.stdout.write(JSON.stringify({
    protocol: "smithers.nanocodex", version: 1, type, seq: seq++, ...correlation, data,
  }) + "\\n");
  emit("hello", capabilities);
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    const command = JSON.parse(line);
    if (command.type !== "turn.start") return;
    let prior = 0;
    try { prior = Number(readFileSync(process.env.FAKE_STATE, "utf8")) || 0; } catch {}
    const turn = prior + 1;
    writeFileSync(process.env.FAKE_STATE, String(turn));
    appendFileSync(process.env.FAKE_CAPTURE, JSON.stringify({ instance: randomUUID(), command }) + "\\n");
    const correlation = {
      requestId: command.requestId, commandId: command.commandId, sessionId: "session-" + turn,
    };
    emit("turn.accepted", {}, correlation);
    if (process.env.FAKE_SCENARIO === "crash-retry" && turn === 2) {
      lines.close();
      setTimeout(() => process.exit(17), 5);
      return;
    }
    const answers = process.env.FAKE_SCENARIO === "normal"
      ? ['{"value":42}']
      : process.env.FAKE_SCENARIO === "crash-retry"
      ? ["not-json", "unused", '{"value":42}']
      : process.env.FAKE_SCENARIO === "cleanup-retry"
        ? ['{"value":1}', '{"value":42}']
      : ["not-json", '{"value":"wrong"}', '{"value":42}'];
    const priorTurns = command.data.continuation?.snapshot?.turns ?? [];
    const completed = {
      finalMessage: answers[turn - 1],
      usage: {
        inputTokens: turn, cachedInputTokens: 0, cacheWriteInputTokens: 0,
        outputTokens: 1, reasoningOutputTokens: 0, totalTokens: turn + 1,
        estimatedUsd: null, costStatus: "usage_not_reported", serviceTier: null,
      },
      model: command.data.options?.model ?? "gpt-5.6-sol",
      snapshotVersion: 1,
      snapshot: { version: 1, turns: [...priorTurns, turn] },
      canonicalWorkspace: command.data.workspace,
    };
    if (process.env.FAKE_SCENARIO === "cleanup-retry" && turn === 1) {
      emit("turn.failed", {
        error: { code: "cleanup_failed", category: "cleanup", message: "Cleanup failed.", retry: "safe" },
        completed: {
          model: completed.model,
          snapshotVersion: completed.snapshotVersion,
          snapshot: completed.snapshot,
          canonicalWorkspace: completed.canonicalWorkspace,
        },
      }, { requestId: command.requestId, sessionId: "session-" + turn });
      process.exitCode = 5;
    } else {
      emit("turn.completed", completed, { requestId: command.requestId, sessionId: "session-" + turn });
    }
    lines.close();
    setTimeout(() => process.exit(0), 5);
  });
} else {
  process.exitCode = 2;
}
`;
}
