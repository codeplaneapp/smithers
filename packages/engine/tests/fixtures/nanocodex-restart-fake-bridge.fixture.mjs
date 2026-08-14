#!__SMITHERS_TEST_RUNTIME__
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const capabilities = {
  bridgeVersion: "0.0.2",
  target:
    process.platform === "darwin" && process.arch === "arm64"
      ? "aarch64-apple-darwin"
      : "x86_64-unknown-linux-gnu",
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

if (process.argv[2] === "capabilities") {
  process.stdout.write(`${JSON.stringify(capabilities)}\n`);
} else if (process.argv[2] === "serve") {
  serve();
} else {
  process.stderr.write("expected capabilities or serve\n");
  process.exitCode = 2;
}

function serve() {
  const instanceId = randomUUID();
  let sequence = 1;
  const emit = (type, data, correlation = {}) => {
    process.stdout.write(
      `${JSON.stringify({
        protocol: "smithers.nanocodex",
        version: 1,
        type,
        seq: sequence++,
        ...correlation,
        data,
      })}\n`,
    );
  };
  emit("hello", capabilities);

  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    const command = JSON.parse(line);
    if (command.type !== "turn.start") return;
    const continuation = command.data.continuation;
    const priorSnapshot = continuation?.snapshot;
    let nonce;
    let finalMessage;
    let snapshot;

    if (continuation === null) {
      nonce = command.data.prompt.match(/SMITHERS_NANOCODEX_RESTART_[A-Z0-9_]+/u)?.[0];
      if (!nonce) throw new Error("initial prompt did not contain the restart nonce");
      finalMessage = "The nonce has been retained for the next turn.";
      snapshot = { version: 1, nonce, turnCount: 1 };
    } else {
      if (continuation?.mode !== "resume" || priorSnapshot?.version !== 1 || priorSnapshot?.turnCount !== 1) {
        throw new Error("resume command did not contain the exact first-turn snapshot");
      }
      nonce = priorSnapshot.nonce;
      if (typeof nonce !== "string" || !nonce.startsWith("SMITHERS_NANOCODEX_RESTART_")) {
        throw new Error("resumed snapshot did not retain the nonce");
      }
      finalMessage = JSON.stringify({ value: 42, nonce });
      snapshot = { ...priorSnapshot, turnCount: 2, recalledNonce: nonce };
    }

    appendFileSync(process.env.FAKE_NANOCODEX_CAPTURE, `${JSON.stringify({ instanceId, command })}\n`, "utf8");
    const correlation = {
      requestId: command.requestId,
      commandId: command.commandId,
      sessionId: `fake-session-${instanceId}`,
    };
    emit("turn.accepted", {}, correlation);
    emit(
      "turn.completed",
      {
        finalMessage,
        usage: {
          inputTokens: 1,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 1,
          reasoningOutputTokens: 0,
          totalTokens: 2,
          estimatedUsd: null,
          costStatus: "usage_not_reported",
          serviceTier: null,
        },
        model: command.data.options?.model ?? "gpt-5.6-sol",
        snapshotVersion: 1,
        snapshot,
        canonicalWorkspace: command.data.workspace,
      },
      { requestId: command.requestId, sessionId: correlation.sessionId },
    );
    lines.close();
    setTimeout(() => process.exit(0), 5);
  });
}
