import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { NanocodexAgent } from "@smithers-orchestrator/agents";
import { Effect } from "effect";
import { z } from "zod";
import { closeSingleRunnerRuntime, createSmithers, runWorkflow, Task, Workflow } from "smithers-orchestrator";
import { jsx } from "smithers-orchestrator/jsx-runtime";

const CONTROLLED_INVALID_TEXT = "SMITHERS_NANOCODEX_CONTROLLED_INVALID_OUTPUT";
const NODE_ID = "work";

function checkpointHash(checkpoint) {
  return createHash("sha256").update(JSON.stringify(checkpoint)).digest("hex");
}

function appendJsonLine(path, value) {
  appendFileSync(path, `${JSON.stringify(value)}\n`, "utf8");
}

function publishJson(path, value) {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, JSON.stringify(value), { encoding: "utf8", flag: "wx" });
    renameSync(temporaryPath, path);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The rename may already have published the complete marker.
    }
    throw error;
  }
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing required ${name}`);
  return value;
}

function procStartTimeTicks(pid) {
  if (process.platform !== "linux" || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fieldsAfterCommand = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/u);
    return /^\d+$/u.test(fieldsAfterCommand[19] ?? "") ? fieldsAfterCommand[19] : null;
  } catch {
    return null;
  }
}

async function main() {
  const [mode, configPath] = process.argv.slice(2);
  if (!configPath || !["initial", "resume"].includes(mode)) {
    throw new Error("expected <initial|resume> <configPath>");
  }

  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const { blockMs, bridgeCapture, dbPath, kind, markerDir, nonce, runId, turnTimeoutMs, workspace } = config;
  if (
    ![dbPath, kind, markerDir, nonce, runId, workspace].every((value) => typeof value === "string" && value) ||
    ![blockMs, turnTimeoutMs].every((value) => Number.isSafeInteger(value) && value > 0) ||
    !["fake", "live"].includes(kind) ||
    (kind === "fake" && (typeof bridgeCapture !== "string" || !bridgeCapture))
  ) {
    throw new Error("restart config is incomplete");
  }

  const binary = requiredEnvironment("SMITHERS_NANOCODEX_BINARY");
  const authFile = kind === "live" ? requiredEnvironment("SMITHERS_NANOCODEX_AUTH_FILE") : null;
  const processInstanceId = randomUUID();
  const providerCallsPath = join(markerDir, "provider-calls.jsonl");
  const lifecyclePath = join(markerDir, `lifecycle-${mode}.jsonl`);
  const bridgeIdentities = new Map();
  const api = createSmithers(
    { result: z.object({ value: z.literal(42), nonce: z.literal(nonce) }) },
    { dbPath, backend: "sqlite" },
  );
  const agent = new NanocodexAgent({
    binary,
    cwd: workspace,
    auth:
      kind === "live"
        ? { mode: "chatgpt", authFile }
        : { mode: "api-key-env", environmentVariable: "FAKE_NANOCODEX_KEY" },
    ...(kind === "fake"
      ? {
          env: {
            FAKE_NANOCODEX_CAPTURE: bridgeCapture,
            FAKE_NANOCODEX_KEY: "provider-free-test-key",
          },
          inheritEnv: false,
        }
      : {}),
    timeoutMs: turnTimeoutMs,
    idleTimeoutMs: turnTimeoutMs,
  });
  const generate = agent.generate.bind(agent);
  let providerCalls = 0;

  agent.generate = async (options = {}) => {
    const hasCheckpoint = options.resumeCheckpoint !== undefined;
    const hash = hasCheckpoint ? checkpointHash(options.resumeCheckpoint) : null;

    if (mode === "initial" && hasCheckpoint) {
      if (options.checkpointMode !== "resume") throw new Error("initial retry did not request resume mode");
      publishJson(join(markerDir, "retry-ready.json"), {
        checkpointMode: options.checkpointMode,
        checkpointHash: hash,
        processInstanceId,
      });
      await new Promise((resolve) => setTimeout(resolve, blockMs));
      throw new Error("initial retry barrier unexpectedly elapsed");
    }

    if (mode === "resume") {
      if (!hasCheckpoint || options.checkpointMode !== "resume") {
        throw new Error("fresh restart process did not receive a resume checkpoint");
      }
      publishJson(join(markerDir, "resumed-received.json"), {
        checkpointMode: options.checkpointMode,
        checkpointHash: hash,
        processInstanceId,
      });
    }

    providerCalls += 1;
    if (providerCalls !== 1) throw new Error(`process ${mode} exceeded its one-turn provider budget`);

    const result = await generate({
      ...options,
      prompt:
        mode === "resume"
          ? [
              "Do not use tools.",
              "Using only the resumed conversation state from the previous turn, recall the nonce you were asked to remember.",
              'Reply with only one raw JSON object whose fields are exactly "value" and "nonce".',
              'Set "value" to the number 42 and "nonce" to that remembered nonce.',
              "Do not include Markdown fences, prose, or any other fields.",
            ].join(" ")
          : [
              "Do not use tools.",
              `Remember the nonce ${nonce} for the next turn.`,
              "Acknowledge that you have retained it; Smithers will validate this turn through a controlled wrapper.",
            ].join(" "),
      onProcess: (event) => {
        let startTimeTicks = bridgeIdentities.get(event.pid) ?? null;
        if (event.phase === "started") {
          startTimeTicks = procStartTimeTicks(event.pid);
          bridgeIdentities.set(event.pid, startTimeTicks);
        }
        appendJsonLine(lifecyclePath, { phase: event.phase, pid: event.pid, startTimeTicks });
        if (event.phase === "exited") bridgeIdentities.delete(event.pid);
        options.onProcess?.(event);
      },
    });
    appendJsonLine(providerCallsPath, { mode, continuation: hasCheckpoint ? "resume" : "fresh" });

    // The real turn, response metadata, and checkpoint remain authoritative.
    // Only the text Smithers parses is replaced, deterministically spending
    // the first task attempt without asking the provider to misbehave.
    return mode === "initial" ? { ...result, text: CONTROLLED_INVALID_TEXT } : result;
  };

  const workflow = api.smithers(() =>
    jsx(Workflow, {
      name: `nanocodex-${kind}-cold-restart`,
      children: jsx(Task, {
        id: NODE_ID,
        output: api.outputs.result,
        agent,
        retries: 1,
        maxSchemaRetries: 0,
        retryPolicy: { backoff: "fixed", initialDelayMs: 0 },
        children: [
          "This is the first turn of a checkpoint restart test. Do not use tools.",
          `Remember the nonce ${nonce} for the next turn.`,
          "A controlled test wrapper, not your response format, will advance the workflow to its retry.",
        ].join(" "),
      }),
    }),
  );

  try {
    const result = await Effect.runPromise(
      runWorkflow(workflow, {
        input: {},
        rootDir: workspace,
        runId,
        ...(mode === "resume" ? { resume: true, force: true } : {}),
      }),
    );
    return { mode, pid: process.pid, processInstanceId, status: result.status };
  } finally {
    await closeSingleRunnerRuntime();
    try {
      api.db.$client?.close?.();
    } catch {
      // The process exit hook is a second best-effort close.
    }
  }
}

main().then(
  (result) => {
    process.stdout.write(`NANOCODEX_RESTART_RESULT=${JSON.stringify(result)}\n`);
    process.exitCode = result.status === "finished" ? 0 : 1;
  },
  (error) => {
    process.stderr.write(
      `nanocodex restart fixture failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  },
);
