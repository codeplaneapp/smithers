import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { DEFAULT_AGENT_CHECKPOINT_MAX_BYTES } from "../src/agent-checkpoint.js";
import {
  NANOCODEX_CHECKPOINT_CAPABILITIES,
  NANOCODEX_CHECKPOINT_CODEC,
  NANOCODEX_CHECKPOINT_FORMATS,
  createNanocodexCheckpoint,
  createNanocodexPolicy,
  createNanocodexPolicyFingerprint,
  createNanocodexPolicyFingerprintInput,
  getNanocodexResumeSnapshot,
  validateNanocodexCheckpoint,
} from "../internal/nanocodex/checkpoint.js";
import {
  NanocodexProtocolValidationError,
  NANOCODEX_BRIDGE_VERSION,
  NANOCODEX_LIMITS,
  NANOCODEX_SHIPPED_TARGETS,
  NANOCODEX_VERSION,
  createServerRecordValidator,
  createTurnCancelCommand,
  createTurnStartCommand,
  getNanocodexRecordBodyByteLength,
  isHelloRecord,
  isTerminalServerRecord,
  parseNanocodexJson,
  validateHelloRecord,
  validateNanocodexCapabilities,
  validateNanocodexStrictJsonValue,
  validateServerRecord,
} from "../internal/nanocodex/protocol.js";

describe("strict Nanocodex JSON parsing", () => {
  test("rejects duplicate keys at every depth without exposing rejected values", () => {
    const secret = "secret-value-must-not-escape";
    let error;
    try {
      parseNanocodexJson(`{"outer":{"key":1,"key":"${secret}"}}`);
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(NanocodexProtocolValidationError);
    expect(error.code).toBe("duplicate_json_key");
    expect(error.message).not.toContain(secret);
  });

  test("treats escaped and literal spellings of the same key as duplicates", () => {
    expect(() => parseNanocodexJson('{"key":1,"k\\u0065y":2}')).toThrow("duplicate object key");
    expect(parseNanocodexJson('{"nested":[true,{"value":2}]}')).toEqual({ nested: [true, { value: 2 }] });
  });

  test("enforces exact producer resource budgets in the lexical pre-scan", () => {
    const errorCode = (text) => {
      try {
        parseNanocodexJson(text);
      } catch (error) {
        expect(error).toBeInstanceOf(NanocodexProtocolValidationError);
        return error.code;
      }
      throw new Error("Expected strict JSON parsing to fail.");
    };
    const jsonNullArray = (length) => `[${"null,".repeat(length - 1)}null]`;

    const exactDepth = `${"[".repeat(NANOCODEX_LIMITS.maxJsonDepth - 1)}null${"]".repeat(
      NANOCODEX_LIMITS.maxJsonDepth - 1,
    )}`;
    expect(() => parseNanocodexJson(exactDepth)).not.toThrow();
    expect(
      errorCode(`${"[".repeat(NANOCODEX_LIMITS.maxJsonDepth)}null${"]".repeat(NANOCODEX_LIMITS.maxJsonDepth)}`),
    ).toBe("json_depth_limit");

    const exactArray = jsonNullArray(NANOCODEX_LIMITS.maxJsonArrayElements);
    expect(() => parseNanocodexJson(exactArray)).not.toThrow();
    expect(errorCode(jsonNullArray(NANOCODEX_LIMITS.maxJsonArrayElements + 1))).toBe("json_array_limit");

    const objectMembers = (length) => `{${Array.from({ length }, (_, member) => `"k${member}":null`).join(",")}}`;
    expect(() => parseNanocodexJson(objectMembers(NANOCODEX_LIMITS.maxJsonObjectMembers))).not.toThrow();
    expect(errorCode(objectMembers(NANOCODEX_LIMITS.maxJsonObjectMembers + 1))).toBe("json_object_limit");

    const leftNodes = NANOCODEX_LIMITS.maxJsonArrayElements;
    const rightNodes = NANOCODEX_LIMITS.maxJsonNodes - leftNodes - 3;
    const nodeObject = (extraNodes) =>
      `{"left":${jsonNullArray(leftNodes)},"right":${jsonNullArray(rightNodes + extraNodes)}}`;
    expect(() => parseNanocodexJson(nodeObject(0))).not.toThrow();
    expect(errorCode(nodeObject(1))).toBe("json_node_limit");

    const exactString = `"${"é".repeat(NANOCODEX_LIMITS.maxJsonStringBytes / 2)}"`;
    expect(() => parseNanocodexJson(exactString)).not.toThrow();
    expect(errorCode(`${exactString.slice(0, -1)}x"`)).toBe("json_string_limit");

    const exactKey = "\\u00e9".repeat(NANOCODEX_LIMITS.maxJsonKeyBytes / 2);
    expect(() => parseNanocodexJson(`{"${exactKey}":null}`)).not.toThrow();
    expect(errorCode(`{"${exactKey}x":null}`)).toBe("json_key_limit");

    expect(parseNanocodexJson('"\\ud83d\\ude00"')).toBe("😀");
    expect(errorCode('"\\ud800"')).toBe("invalid_json_value");
    expect(errorCode('"\\udfff"')).toBe("invalid_json_value");
    expect(errorCode("null true")).toBe("invalid_json");
  });

  test("enforces every producer JSON resource boundary at exact and one-over values", () => {
    expect(() => validateNanocodexStrictJsonValue(nestedJsonArray(NANOCODEX_LIMITS.maxJsonDepth - 1))).not.toThrow();
    expect(() => validateNanocodexStrictJsonValue(nestedJsonArray(NANOCODEX_LIMITS.maxJsonDepth))).toThrow(
      "nesting limit",
    );

    const exactNodeElements = NANOCODEX_LIMITS.maxJsonNodes - 3;
    const exactNodes = {
      left: Array(NANOCODEX_LIMITS.maxJsonArrayElements).fill(null),
      right: Array(exactNodeElements - NANOCODEX_LIMITS.maxJsonArrayElements).fill(null),
    };
    expect(jsonNodeCount(exactNodes)).toBe(NANOCODEX_LIMITS.maxJsonNodes);
    expect(() => validateNanocodexStrictJsonValue(exactNodes)).not.toThrow();
    exactNodes.right.push(null);
    expect(() => validateNanocodexStrictJsonValue(exactNodes)).toThrow("total-node limit");

    const exactMembers = Object.fromEntries(
      Array.from({ length: NANOCODEX_LIMITS.maxJsonObjectMembers }, (_, index) => [`k${index}`, null]),
    );
    expect(() => validateNanocodexStrictJsonValue(exactMembers)).not.toThrow();
    exactMembers.extra = null;
    expect(() => validateNanocodexStrictJsonValue(exactMembers)).toThrow("member limit");

    expect(() =>
      validateNanocodexStrictJsonValue(Array(NANOCODEX_LIMITS.maxJsonArrayElements).fill(null)),
    ).not.toThrow();
    expect(() => validateNanocodexStrictJsonValue(Array(NANOCODEX_LIMITS.maxJsonArrayElements + 1).fill(null))).toThrow(
      "element limit",
    );

    expect(() => validateNanocodexStrictJsonValue("x".repeat(NANOCODEX_LIMITS.maxJsonStringBytes))).not.toThrow();
    expect(() => validateNanocodexStrictJsonValue("x".repeat(NANOCODEX_LIMITS.maxJsonStringBytes + 1))).toThrow(
      "decoded UTF-8 limit",
    );

    expect(() =>
      validateNanocodexStrictJsonValue({ ["é".repeat(NANOCODEX_LIMITS.maxJsonKeyBytes / 2)]: null }),
    ).not.toThrow();
    expect(() =>
      validateNanocodexStrictJsonValue({ [`${"é".repeat(NANOCODEX_LIMITS.maxJsonKeyBytes / 2)}x`]: null }),
    ).toThrow("key exceeds");
  });

  test("rejects non-scalar JSON strings and keys", () => {
    for (const value of ["\ud800", "\udfff", { ["\ud800"]: true }, { nested: "\udfff" }]) {
      expect(() => validateNanocodexStrictJsonValue(value)).toThrow("unpaired UTF-16 surrogate");
    }
    expect(() => parseNanocodexJson('{"value":"\\ud800"}')).toThrow("unpaired UTF-16 surrogate");
  });
});

function capabilities() {
  return {
    bridgeVersion: NANOCODEX_BRIDGE_VERSION,
    target: NANOCODEX_SHIPPED_TARGETS[0],
    nanocodexVersion: NANOCODEX_VERSION,
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
      maxInputRecordBytes: 25_165_824,
      maxOutputRecordBytes: 41_943_040,
      maxPromptBytes: 4_194_304,
      maxSnapshotBytes: 15_728_640,
      maxEventBytes: 1_048_576,
      maxEventTotalBytes: 16_777_216,
      maxStderrBytes: 65_536,
      maxCommandRecords: 256,
      maxJsonDepth: 64,
      maxJsonNodes: 262_144,
      maxJsonObjectMembers: 16_384,
      maxJsonArrayElements: 131_072,
      maxJsonStringBytes: 18_874_368,
      maxJsonKeyBytes: 1_024,
      maxManagedAuthFileBytes: 1_048_576,
    },
  };
}

function hello(seq = 1) {
  return {
    protocol: "smithers.nanocodex",
    version: 1,
    type: "hello",
    seq,
    data: capabilities(),
  };
}

function publicError(overrides = {}) {
  return {
    code: "provider_unavailable",
    category: "provider",
    message: "The provider is temporarily unavailable.",
    retry: "safe",
    ...overrides,
  };
}

function usage() {
  return {
    inputTokens: 7,
    cachedInputTokens: 2,
    cacheWriteInputTokens: 0,
    outputTokens: 3,
    reasoningOutputTokens: 1,
    totalTokens: 10,
    estimatedUsd: null,
    costStatus: "usage_not_reported",
    serviceTier: null,
  };
}

function completedData() {
  return {
    finalMessage: "done",
    usage: usage(),
    model: "gpt-5.6-sol",
    snapshotVersion: 1,
    snapshot: { version: 1, history: [{ role: "assistant", text: "done" }] },
    canonicalWorkspace: "/tmp/worktree",
  };
}

function recoveryData() {
  const { model, snapshotVersion, snapshot, canonicalWorkspace } = completedData();
  return { model, snapshotVersion, snapshot, canonicalWorkspace };
}

function correlatedRecord(type, seq, data, extras = {}) {
  return {
    protocol: "smithers.nanocodex",
    version: 1,
    type,
    seq,
    requestId: "request-1",
    sessionId: "session-1",
    data,
    ...extras,
  };
}

function assistantEvent(text = "ok") {
  return {
    type: "assistant.delta",
    upstreamSeq: 7,
    payload: { modelCallIndex: 0, itemId: null, phase: null, text },
  };
}

function projectedToolEvents(callId = "call-1", tool = "exec_command") {
  return [
    {
      type: "tool.call",
      upstreamSeq: 8,
      payload: { callId, tool, modelCallIndex: 1 },
    },
    {
      type: "tool.result",
      upstreamSeq: 9,
      payload: { callId, tool, status: "completed", durationNs: 12, startedAfterNs: null },
    },
  ];
}

function fixture(name) {
  return readFileSync(new URL(`./fixtures/nanocodex/${name}`, import.meta.url), "utf8");
}

function jsonObjectWithEncodedBytes(bytes) {
  const emptyBytes = Buffer.byteLength(JSON.stringify({ payload: "" }), "utf8");
  if (bytes < emptyBytes) throw new RangeError("Encoded object size is too small.");
  const value = { payload: "x".repeat(bytes - emptyBytes) };
  expect(Buffer.byteLength(JSON.stringify(value), "utf8")).toBe(bytes);
  return value;
}

function nestedJsonArray(depth) {
  let value = null;
  for (let index = 0; index < depth; index += 1) value = [value];
  return value;
}

function jsonNodeCount(value) {
  let nodes = 0;
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    nodes += 1;
    if (Array.isArray(current)) pending.push(...current);
    else if (current !== null && typeof current === "object") pending.push(...Object.values(current));
  }
  return nodes;
}

function assistantEventWithEncodedBytes(bytes) {
  const empty = assistantEvent("");
  const emptyBytes = Buffer.byteLength(JSON.stringify(empty), "utf8");
  if (bytes < emptyBytes) throw new RangeError("Projected event size is too small.");
  const event = assistantEvent("x".repeat(bytes - emptyBytes));
  expect(Buffer.byteLength(JSON.stringify(event), "utf8")).toBe(bytes);
  return event;
}

describe("Nanocodex capability and server protocol validation", () => {
  test("uses one exact validator for capabilities output and hello.data", () => {
    const value = capabilities();
    expect(validateNanocodexCapabilities(value)).toBe(value);
    expect(validateHelloRecord(hello()).data).toBeInstanceOf(Object);
    expect(isHelloRecord(hello())).toBe(true);
    expect(isHelloRecord({ type: "turn.completed" })).toBe(false);

    const unknownTopLevel = capabilities();
    unknownTopLevel.extra = true;
    expect(() => validateNanocodexCapabilities(unknownTopLevel)).toThrow("invalid field set");

    const unknownNested = capabilities();
    unknownNested.features.extra = true;
    expect(() => validateNanocodexCapabilities(unknownNested)).toThrow("invalid field set");
  });

  test("fails closed on protocol, library, checkpoint, feature, and limit mismatches", () => {
    const mutations = [
      (value) => (value.bridgeVersion = ""),
      (value) => (value.nanocodexVersion = "0.3.0"),
      (value) => (value.protocol.name = "other"),
      (value) => (value.protocol.versions = [1, 2]),
      (value) => (value.checkpoint.codecVersions = [2]),
      (value) => (value.checkpoint.snapshotVersions = [2]),
      (value) => (value.checkpoint.continuationModes = ["fork"]),
      (value) => (value.checkpoint.resumeRequiresSameCanonicalWorkspace = false),
      (value) => (value.target = "aarch64-unknown-linux-gnu"),
      (value) => (value.models = ["gpt-5.6-sol"]),
      (value) => (value.defaultModel = "gpt-5.6-terra"),
      (value) => (value.thinkingLevels = ["low", "medium", "high"]),
      (value) => (value.defaultThinking = "medium"),
      (value) => (value.reasoningModes = ["standard"]),
      (value) => (value.features.codeMode = false),
      (value) => (value.features.mcp = true),
      (value) => (value.features.subagents = true),
      (value) => (value.features.workspaceRelocation = true),
      ...Object.keys(NANOCODEX_LIMITS).map((key) => (value) => (value.limits[key] += 1)),
    ];
    for (const mutate of mutations) {
      const value = capabilities();
      mutate(value);
      expect(() => validateNanocodexCapabilities(value)).toThrow();
    }
  });

  test("requires all 15 authoritative v0.0.2 limit fields and values", () => {
    expect(Object.keys(capabilities().limits)).toHaveLength(15);
    expect(capabilities().limits).toEqual(NANOCODEX_LIMITS);
    for (const key of Object.keys(NANOCODEX_LIMITS)) {
      const missing = capabilities();
      delete missing.limits[key];
      expect(() => validateNanocodexCapabilities(missing)).toThrow();
    }
  });

  test("measures record bodies without charging the JSONL LF", () => {
    const emptyBytes = Buffer.byteLength(JSON.stringify({ left: "", right: "" }), "utf8");
    const remainingStringBytes = NANOCODEX_LIMITS.maxInputRecordBytes - emptyBytes;
    const body = {
      left: "x".repeat(NANOCODEX_LIMITS.maxJsonStringBytes),
      right: "x".repeat(remainingStringBytes - NANOCODEX_LIMITS.maxJsonStringBytes),
    };
    expect(getNanocodexRecordBodyByteLength(body)).toBe(NANOCODEX_LIMITS.maxInputRecordBytes);
    expect(Buffer.byteLength(`${JSON.stringify(body)}\n`, "utf8")).toBe(NANOCODEX_LIMITS.maxInputRecordBytes + 1);
  });

  test("consumes Smithers-owned copies of the authoritative v0.0.2 wire fixtures", () => {
    const clientStart = parseNanocodexJson(fixture("client-success-v1.jsonl").trimEnd());
    expect(
      createTurnStartCommand({
        commandId: clientStart.commandId,
        requestId: clientStart.requestId,
        ...clientStart.data,
      }),
    ).toEqual(clientStart);
    const clientCancel = parseNanocodexJson(fixture("client-cancel-v1.jsonl").trimEnd());
    expect(
      createTurnCancelCommand({
        commandId: clientCancel.commandId,
        requestId: clientCancel.requestId,
        sessionId: clientCancel.sessionId,
        reason: clientCancel.data.reason,
      }),
    ).toEqual(clientCancel);

    const validate = createServerRecordValidator({ requestId: "request-1", startCommandId: "command-1" });
    const records = fixture("server-success-v1.jsonl")
      .trimEnd()
      .split("\n")
      .map((line) => parseNanocodexJson(line));
    expect(records.map((record) => validate(record).type)).toEqual([
      "hello",
      "turn.accepted",
      "agent.event",
      "agent.event-truncated",
      "turn.completed",
    ]);
  });

  test("strictly validates every supported server record shape", () => {
    const records = [
      hello(),
      correlatedRecord("turn.accepted", 2, {}, { commandId: "start-command" }),
      correlatedRecord("agent.event", 3, { event: assistantEvent() }),
      correlatedRecord("agent.event-truncated", 4, {
        upstreamType: "api.event",
        upstreamSeq: 8,
        reason: "event_policy",
      }),
      correlatedRecord("command.accepted", 5, { command: "turn.cancel" }, { commandId: "cancel-1" }),
      correlatedRecord("command.rejected", 6, { error: publicError() }, { commandId: "cancel-2" }),
      correlatedRecord("turn.completed", 7, completedData()),
      correlatedRecord("turn.failed", 8, { error: publicError() }),
      correlatedRecord("turn.cancelled", 9, { reason: "cancelled" }),
      {
        protocol: "smithers.nanocodex",
        version: 1,
        type: "process.failed",
        seq: 2,
        requestId: "request-1",
        data: { error: publicError({ category: "protocol", retry: "never" }) },
      },
    ];

    for (const record of records) expect(validateServerRecord(record)).toBe(record);

    const missingCompletedModel = completedData();
    delete missingCompletedModel.model;
    expect(() => validateServerRecord(correlatedRecord("turn.completed", 7, missingCompletedModel))).toThrow(
      "invalid field set",
    );
    expect(() =>
      validateServerRecord(correlatedRecord("turn.completed", 7, { ...completedData(), model: "gpt-4o" })),
    ).toThrow("model");
    const missingRecoveryModel = recoveryData();
    delete missingRecoveryModel.model;
    expect(() =>
      validateServerRecord(
        correlatedRecord("turn.failed", 8, {
          error: publicError({ category: "cleanup", code: "cleanup_failed" }),
          completed: missingRecoveryModel,
        }),
      ),
    ).toThrow("invalid field set");
    for (const record of records) {
      const withExtra = { ...record, unexpected: true };
      expect(() => validateServerRecord(withExtra)).toThrow("invalid field set");
    }

    expect(() => validateServerRecord({ ...hello(), protocol: "other" })).toThrow("incompatible");
    expect(() => validateServerRecord({ ...hello(), version: 2 })).toThrow("incompatible");
    expect(() => validateServerRecord({ ...hello(), seq: Number.MAX_SAFE_INTEGER + 1 })).toThrow("integer");
    expect(() => validateServerRecord({ ...hello(), type: "future.record" })).toThrow("not supported");

    expect(() =>
      validateServerRecord(correlatedRecord("turn.cancelled", 9, { reason: "x".repeat(127) + "é" })),
    ).toThrow("untrusted text");
    expect(() => validateServerRecord(correlatedRecord("turn.cancelled", 9, { reason: "line\nbreak" }))).toThrow(
      "untrusted text",
    );
  });

  test("enforces exact safe projections for every protocol v1 agent event family", () => {
    const [toolCall, toolResult] = projectedToolEvents();
    const projected = [
      assistantEvent(),
      { ...assistantEvent("complete"), type: "assistant.message" },
      toolCall,
      toolResult,
      { type: "run.error", upstreamSeq: 10, payload: {} },
      { type: "model.connection.failed", upstreamSeq: 11, payload: {} },
      { type: "future.event", upstreamSeq: 12, payload: { ignored: "opaque" } },
    ];
    for (const [index, event] of projected.entries()) {
      expect(validateServerRecord(correlatedRecord("agent.event", index + 2, { event }))).toBeDefined();
    }

    const invalid = [
      { ...assistantEvent(), payload: { ...assistantEvent().payload, arguments: { secret: true } } },
      { type: "tool.call", upstreamSeq: 1, payload: { callId: "x", tool: "t", modelCallIndex: 0, arguments: {} } },
      {
        type: "tool.result",
        upstreamSeq: 1,
        payload: { callId: "x", tool: "t", status: "new", durationNs: 0, startedAfterNs: null },
      },
      { type: "run.started", upstreamSeq: 1, payload: { workspace: "/secret" } },
      { type: "api.event", upstreamSeq: 1, payload: {} },
      { type: "reasoning.summary.delta", upstreamSeq: 1, payload: {} },
    ];
    for (const event of invalid) {
      expect(() => validateServerRecord(correlatedRecord("agent.event", 2, { event }))).toThrow();
    }
  });

  test("accepts exact UTF-8 tool identifier boundaries for correlated calls and results", () => {
    const identifierBoundaries = [
      ["callId", 256],
      ["tool", 128],
    ];

    for (const [field, maximumBytes] of identifierBoundaries) {
      const exact = "é".repeat(maximumBytes / 2);
      expect(Buffer.byteLength(exact, "utf8")).toBe(maximumBytes);
      const identifiers = { callId: "call-1", tool: "exec_command", [field]: exact };
      for (const event of projectedToolEvents(identifiers.callId, identifiers.tool)) {
        expect(validateServerRecord(correlatedRecord("agent.event", 2, { event }))).toBeDefined();
      }

      const oneOver = `${exact}x`;
      expect(Buffer.byteLength(oneOver, "utf8")).toBe(maximumBytes + 1);
      const oversized = { ...identifiers, [field]: oneOver };
      for (const event of projectedToolEvents(oversized.callId, oversized.tool)) {
        expect(() => validateServerRecord(correlatedRecord("agent.event", 2, { event }))).toThrow(
          "projected tool identifier",
        );
      }
    }
  });

  test("rejects empty, non-scalar, and control-bearing tool identifiers in calls and results", () => {
    const hostileIdentifiers = [
      "",
      "line\nbreak",
      "nul\u0000byte",
      "delete\u007fbyte",
      "c1\u0085control",
      "ansi\u001b[31mred",
      "lone-surrogate-\ud800",
    ];

    for (const hostile of hostileIdentifiers) {
      for (const field of ["callId", "tool"]) {
        const identifiers = { callId: "call-1", tool: "exec_command", [field]: hostile };
        for (const event of projectedToolEvents(identifiers.callId, identifiers.tool)) {
          expect(() => validateServerRecord(correlatedRecord("agent.event", 2, { event }))).toThrow();
        }
      }
    }
  });

  test("does not expose rejected projected tool identifiers in validation errors", () => {
    const rejected = "secret-tool-identifier\u001b[31m";
    for (const event of projectedToolEvents(rejected, rejected)) {
      let caught;
      try {
        validateServerRecord(correlatedRecord("agent.event", 2, { event }));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(NanocodexProtocolValidationError);
      expect(caught.code).toBe("invalid_agent_event");
      expect(String(caught)).not.toContain(rejected);
      expect(JSON.stringify(caught)).not.toContain(rejected);
    }
  });

  test("enforces the projected-event byte ceiling including the 1,024-byte reserve", () => {
    const exact = assistantEventWithEncodedBytes(NANOCODEX_LIMITS.maxEventBytes - 1_024);
    expect(validateServerRecord(correlatedRecord("agent.event", 2, { event: exact }))).toBeDefined();

    const oneOver = assistantEventWithEncodedBytes(NANOCODEX_LIMITS.maxEventBytes - 1_024 + 1);
    expect(() => validateServerRecord(correlatedRecord("agent.event", 2, { event: oneOver }))).toThrow(
      "per-event protocol limit",
    );
  });

  test("accounts aggregate projected events and enforces marker suppression semantics", () => {
    const validate = createServerRecordValidator({ requestId: "request-1", startCommandId: "start-command" });
    validate(hello());
    validate(correlatedRecord("turn.accepted", 2, {}, { commandId: "start-command" }));
    const maximumChargedEvent = assistantEventWithEncodedBytes(NANOCODEX_LIMITS.maxEventBytes - 1_024);
    let seq = 3;
    for (let index = 0; index < 15; index += 1) {
      validate(correlatedRecord("agent.event", seq, { event: maximumChargedEvent }));
      seq += 1;
    }

    expect(() => validate(correlatedRecord("agent.event", seq, { event: maximumChargedEvent }))).toThrow(
      "omitted the aggregate event-limit marker",
    );
    expect(
      validate(
        correlatedRecord("agent.event-truncated", seq, {
          upstreamType: "assistant.delta",
          upstreamSeq: 16,
          reason: "aggregate_event_limit",
        }),
      ).type,
    ).toBe("agent.event-truncated");
    seq += 1;
    expect(() => validate(correlatedRecord("agent.event", seq, { event: maximumChargedEvent }))).toThrow(
      "after aggregate suppression",
    );

    const premature = createServerRecordValidator({ requestId: "request-1", startCommandId: "start-command" });
    premature(hello());
    premature(correlatedRecord("turn.accepted", 2, {}, { commandId: "start-command" }));
    expect(() =>
      premature(
        correlatedRecord("agent.event-truncated", 3, {
          upstreamType: "assistant.delta",
          upstreamSeq: 1,
          reason: "aggregate_event_limit",
        }),
      ),
    ).toThrow("marker early");
  });

  test("accepts the exact aggregate boundary when backpressure hides a charged event", () => {
    const validate = createServerRecordValidator({ requestId: "request-1", startCommandId: "start-command" });
    validate(hello());
    validate(correlatedRecord("turn.accepted", 2, {}, { commandId: "start-command" }));
    const maximumChargedEvent = assistantEventWithEncodedBytes(NANOCODEX_LIMITS.maxEventBytes - 1_024);
    let seq = 3;

    // Fourteen visible maximum charges plus one maximum charge hidden by
    // backpressure put the producer at fifteen MiB. The next maximum event and
    // final marker reserve cross the exact aggregate boundary.
    for (let index = 0; index < 14; index += 1) {
      validate(correlatedRecord("agent.event", seq, { event: maximumChargedEvent }));
      seq += 1;
    }
    validate(
      correlatedRecord("agent.event-truncated", seq, {
        upstreamType: null,
        upstreamSeq: null,
        reason: "bridge_event_backpressure",
      }),
    );
    seq += 1;
    expect(
      validate(
        correlatedRecord("agent.event-truncated", seq, {
          upstreamType: "assistant.delta",
          upstreamSeq: 16,
          reason: "aggregate_event_limit",
        }),
      ).type,
    ).toBe("agent.event-truncated");
    seq += 1;
    expect(validate(correlatedRecord("turn.completed", seq, completedData())).type).toBe("turn.completed");

    const receivedLimit = createServerRecordValidator({
      requestId: "request-1",
      startCommandId: "start-command",
    });
    receivedLimit(hello());
    receivedLimit(correlatedRecord("turn.accepted", 2, {}, { commandId: "start-command" }));
    seq = 3;
    for (let index = 0; index < 15; index += 1) {
      receivedLimit(correlatedRecord("agent.event", seq, { event: maximumChargedEvent }));
      seq += 1;
    }
    receivedLimit(
      correlatedRecord("agent.event-truncated", seq, {
        upstreamType: null,
        upstreamSeq: null,
        reason: "bridge_event_backpressure",
      }),
    );
    seq += 1;
    expect(() => receivedLimit(correlatedRecord("agent.event", seq, { event: maximumChargedEvent }))).toThrow(
      "omitted the aggregate event-limit marker",
    );
  });

  test("enforces exact truncation-marker correlation and policy types", () => {
    expect(() =>
      validateServerRecord(
        correlatedRecord("agent.event-truncated", 2, {
          upstreamType: "assistant.delta",
          upstreamSeq: 1,
          reason: "bridge_event_backpressure",
        }),
      ),
    ).toThrow("null upstream correlation");
    expect(() =>
      validateServerRecord(
        correlatedRecord("agent.event-truncated", 2, {
          upstreamType: "assistant.delta",
          upstreamSeq: 1,
          reason: "event_policy",
        }),
      ),
    ).toThrow("invalid upstream event type");
    expect(
      validateServerRecord(
        correlatedRecord("agent.event-truncated", 2, {
          upstreamType: null,
          upstreamSeq: null,
          reason: "bridge_event_backpressure",
        }),
      ).type,
    ).toBe("agent.event-truncated");
  });

  test("validates public error retry rules and recoverable cleanup terminals", () => {
    const retryAfter = correlatedRecord("turn.failed", 3, {
      error: publicError({ retry: "after", retryAfterMs: 250 }),
    });
    expect(validateServerRecord(retryAfter)).toBe(retryAfter);

    const invalidRetry = structuredClone(retryAfter);
    invalidRetry.data.error.retry = "safe";
    expect(() => validateServerRecord(invalidRetry)).toThrow("retryAfterMs");

    const missingRetryAfter = structuredClone(retryAfter);
    delete missingRetryAfter.data.error.retryAfterMs;
    expect(() => validateServerRecord(missingRetryAfter)).toThrow("requires retryAfterMs");

    const numericCost = correlatedRecord("turn.completed", 3, completedData());
    numericCost.data.usage.estimatedUsd = 0.01;
    expect(() => validateServerRecord(numericCost)).toThrow("usage");
    const decimalCost = correlatedRecord("turn.completed", 3, completedData());
    decimalCost.data.usage.estimatedUsd = "0.0100";
    expect(validateServerRecord(decimalCost)).toBe(decimalCost);

    const recoverable = correlatedRecord("turn.failed", 3, {
      error: publicError({ code: "cleanup_failed", category: "cleanup" }),
      completed: recoveryData(),
    });
    expect(validateServerRecord(recoverable)).toBe(recoverable);

    const wrongCategory = structuredClone(recoverable);
    wrongCategory.data.error.category = "provider";
    expect(() => validateServerRecord(wrongCategory)).toThrow("cleanup_failed");

    const wrongCode = structuredClone(recoverable);
    wrongCode.data.error.code = "other_cleanup_failure";
    expect(() => validateServerRecord(wrongCode)).toThrow("cleanup_failed");
  });

  test("counts schema maxLength strings by Unicode code points", () => {
    const accepted = correlatedRecord("turn.failed", 3, {
      error: publicError({ message: "😀".repeat(513) }),
    });
    expect(validateServerRecord(accepted)).toBe(accepted);
    accepted.data.error.message += "😀";
    expect(() => validateServerRecord(accepted)).toThrow("protocol string is invalid");
  });

  test("enforces sequence, acceptance, correlation, and terminal state per process", () => {
    const validate = createServerRecordValidator({
      requestId: "request-1",
      startCommandId: "start-command",
    });
    expect(validate(hello()).type).toBe("hello");
    expect(validate(correlatedRecord("turn.accepted", 2, {}, { commandId: "start-command" })).type).toBe(
      "turn.accepted",
    );
    expect(validate(correlatedRecord("agent.event", 3, { event: assistantEvent() })).type).toBe("agent.event");
    const terminal = validate(correlatedRecord("turn.completed", 4, completedData()));
    expect(isTerminalServerRecord(terminal)).toBe(true);
    expect(() => validate(correlatedRecord("turn.cancelled", 5, { reason: "late" }))).toThrow("after its terminal");

    const missingFirst = createServerRecordValidator();
    expect(() => missingFirst({ ...hello(), seq: 2 })).toThrow("start at 1");

    const gap = createServerRecordValidator();
    gap(hello());
    expect(() => gap(correlatedRecord("turn.accepted", 3, {}, { commandId: "start-command" }))).toThrow(
      "increase by one",
    );

    const eventBeforeAcceptance = createServerRecordValidator({ requestId: "request-1" });
    eventBeforeAcceptance(hello());
    expect(() => eventBeforeAcceptance(correlatedRecord("agent.event", 2, { event: assistantEvent() }))).toThrow(
      "before acceptance",
    );

    const correlationMismatch = createServerRecordValidator({
      requestId: "request-1",
      startCommandId: "start-command",
    });
    correlationMismatch(hello());
    expect(() =>
      correlationMismatch(
        correlatedRecord("turn.accepted", 2, {}, { requestId: "request-2", commandId: "start-command" }),
      ),
    ).toThrow("correlation");
  });

  test("allows pre-acceptance cancel acknowledgement followed by process.failed", () => {
    const validate = createServerRecordValidator({
      requestId: "request-1",
      startCommandId: "start-command",
    });
    validate(hello());
    const cancel = createTurnCancelCommand({ commandId: "cancel-command", requestId: "request-1" });
    validate.registerCancelCommand(cancel);
    validate({
      protocol: "smithers.nanocodex",
      version: 1,
      type: "command.accepted",
      seq: 2,
      requestId: "request-1",
      commandId: "cancel-command",
      data: { command: "turn.cancel" },
    });
    const terminal = validate({
      protocol: "smithers.nanocodex",
      version: 1,
      type: "process.failed",
      seq: 3,
      requestId: "request-1",
      data: { error: publicError({ code: "cancelled_before_acceptance", category: "protocol", retry: "never" }) },
    });
    expect(terminal.type).toBe("process.failed");
  });

  test("retains acknowledged pre-session cancellation and forbids later turn acceptance", () => {
    const validate = createServerRecordValidator({
      requestId: "request-1",
      startCommandId: "start-command",
    });
    validate(hello());
    validate.registerCancelCommand(createTurnCancelCommand({ commandId: "cancel-command", requestId: "request-1" }));
    validate({
      protocol: "smithers.nanocodex",
      version: 1,
      type: "command.accepted",
      seq: 2,
      requestId: "request-1",
      commandId: "cancel-command",
      data: { command: "turn.cancel" },
    });
    expect(() => validate(correlatedRecord("turn.accepted", 3, {}, { commandId: "start-command" }))).toThrow(
      "after acknowledging cancellation",
    );
  });

  test("requires turn.cancelled after acknowledging an exact-session cancellation", () => {
    const validate = createServerRecordValidator({ requestId: "request-1", startCommandId: "start-command" });
    validate(hello());
    validate(correlatedRecord("turn.accepted", 2, {}, { commandId: "start-command" }));
    validate.registerCancelCommand(
      createTurnCancelCommand({
        commandId: "cancel-command",
        requestId: "request-1",
        sessionId: "session-1",
      }),
    );
    validate(correlatedRecord("command.accepted", 3, { command: "turn.cancel" }, { commandId: "cancel-command" }));
    expect(() => validate(correlatedRecord("turn.completed", 4, completedData()))).toThrow("wrong terminal");
    expect(() => validate(correlatedRecord("turn.failed", 4, { error: publicError() }))).toThrow("wrong terminal");
    expect(validate(correlatedRecord("turn.cancelled", 4, { reason: "cancelled" })).type).toBe("turn.cancelled");
  });

  test("allows ordinary lifecycle after cancellation is rejected", () => {
    const beforeAcceptance = createServerRecordValidator({
      requestId: "request-1",
      startCommandId: "start-command",
    });
    beforeAcceptance(hello());
    beforeAcceptance.registerCancelCommand(
      createTurnCancelCommand({ commandId: "cancel-before", requestId: "request-1" }),
    );
    beforeAcceptance({
      protocol: "smithers.nanocodex",
      version: 1,
      type: "command.rejected",
      seq: 2,
      requestId: "request-1",
      commandId: "cancel-before",
      data: { error: publicError({ category: "protocol", retry: "never" }) },
    });
    beforeAcceptance(correlatedRecord("turn.accepted", 3, {}, { commandId: "start-command" }));
    expect(beforeAcceptance(correlatedRecord("turn.completed", 4, completedData())).type).toBe("turn.completed");

    const afterAcceptance = createServerRecordValidator({
      requestId: "request-1",
      startCommandId: "start-command",
    });
    afterAcceptance(hello());
    afterAcceptance(correlatedRecord("turn.accepted", 2, {}, { commandId: "start-command" }));
    afterAcceptance.registerCancelCommand(
      createTurnCancelCommand({
        commandId: "cancel-after",
        requestId: "request-1",
        sessionId: "session-1",
      }),
    );
    afterAcceptance(correlatedRecord("command.rejected", 3, { error: publicError() }, { commandId: "cancel-after" }));
    expect(afterAcceptance(correlatedRecord("turn.completed", 4, completedData())).type).toBe("turn.completed");
  });

  test("accepts cancel outcomes only for one actually registered outbound command ID", () => {
    const validate = createServerRecordValidator({ requestId: "request-1", startCommandId: "start-command" });
    validate(hello());
    validate(correlatedRecord("turn.accepted", 2, {}, { commandId: "start-command" }));

    const forged = correlatedRecord("command.accepted", 3, { command: "turn.cancel" }, { commandId: "forged" });
    expect(() => validate(forged)).toThrow("not registered");

    const cancel = createTurnCancelCommand({
      commandId: "cancel-command",
      requestId: "request-1",
      sessionId: "session-1",
      reason: "idle_timeout",
    });
    validate.registerCancelCommand(cancel);
    expect(
      validate(correlatedRecord("command.accepted", 3, { command: "turn.cancel" }, { commandId: "cancel-command" })),
    ).toBeDefined();
    expect(() => validate.registerCancelCommand(cancel)).toThrow("only once");
    expect(() =>
      validate(correlatedRecord("command.accepted", 4, { command: "turn.cancel" }, { commandId: "cancel-command" })),
    ).toThrow("not registered");
  });

  test("rejects terminals while a registered cancellation lacks its outcome", () => {
    const beforeAcceptance = createServerRecordValidator({
      requestId: "request-1",
      startCommandId: "start-command",
    });
    beforeAcceptance(hello());
    beforeAcceptance.registerCancelCommand(
      createTurnCancelCommand({ commandId: "cancel-before", requestId: "request-1" }),
    );
    expect(() =>
      beforeAcceptance({
        protocol: "smithers.nanocodex",
        version: 1,
        type: "process.failed",
        seq: 2,
        requestId: "request-1",
        data: { error: publicError({ category: "protocol", retry: "never" }) },
      }),
    ).toThrow("before acknowledging a registered command");

    const afterAcceptance = createServerRecordValidator({
      requestId: "request-1",
      startCommandId: "start-command",
    });
    afterAcceptance(hello());
    afterAcceptance(correlatedRecord("turn.accepted", 2, {}, { commandId: "start-command" }));
    afterAcceptance.registerCancelCommand(
      createTurnCancelCommand({
        commandId: "cancel-after",
        requestId: "request-1",
        sessionId: "session-1",
      }),
    );
    expect(() => afterAcceptance(correlatedRecord("turn.cancelled", 3, { reason: "cancelled" }))).toThrow(
      "before acknowledging a registered command",
    );
  });

  test("rejects cancel registration with the wrong request, session, phase, or reused start ID", () => {
    const validate = createServerRecordValidator({ requestId: "request-1", startCommandId: "start-command" });
    expect(() =>
      validate.registerCancelCommand(createTurnCancelCommand({ commandId: "early", requestId: "request-1" })),
    ).toThrow("current state");
    validate(hello());
    expect(() =>
      validate.registerCancelCommand(createTurnCancelCommand({ commandId: "wrong", requestId: "request-2" })),
    ).toThrow("correlation");
    expect(() =>
      validate.registerCancelCommand(createTurnCancelCommand({ commandId: "start-command", requestId: "request-1" })),
    ).toThrow("only once");
    validate(correlatedRecord("turn.accepted", 2, {}, { commandId: "start-command" }));
    expect(() =>
      validate.registerCancelCommand(
        createTurnCancelCommand({ commandId: "wrong-session", requestId: "request-1", sessionId: "session-2" }),
      ),
    ).toThrow("correlation");
    expect(() =>
      validate.registerCancelCommand({
        ...createTurnCancelCommand({ commandId: "null-session", requestId: "request-1" }),
        sessionId: null,
      }),
    ).toThrow("safe ASCII");
    expect(() =>
      validate.registerCancelCommand({
        ...createTurnCancelCommand({ commandId: "null-reason", requestId: "request-1", sessionId: "session-1" }),
        data: { reason: null },
      }),
    ).toThrow("untrusted text");
  });

  test("never serializes rejected secret-bearing protocol input into errors", () => {
    const sentinel = "secret-sentinel-do-not-serialize";
    const record = hello();
    record.data.protocol.name = sentinel;
    let caught;
    try {
      validateHelloRecord(record);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(NanocodexProtocolValidationError);
    expect(String(caught)).not.toContain(sentinel);
    expect(JSON.stringify(caught)).not.toContain(sentinel);

    const secretKey = hello();
    secretKey.data[sentinel] = true;
    expect(() => validateHelloRecord(secretKey)).toThrow("invalid field set");
    try {
      validateHelloRecord(secretKey);
    } catch (error) {
      expect(String(error)).not.toContain(sentinel);
    }
  });
});

describe("Nanocodex client commands", () => {
  test("builds an exact fresh turn.start without credential values", () => {
    const command = createTurnStartCommand({
      commandId: "start-command",
      requestId: "request-1",
      prompt: "Implement the task.",
      workspace: "/tmp/worktree",
      auth: { mode: "api-key-env", environmentVariable: "OPENAI_API_KEY" },
    });
    expect(command).toEqual({
      protocol: "smithers.nanocodex",
      version: 1,
      type: "turn.start",
      commandId: "start-command",
      requestId: "request-1",
      data: {
        prompt: "Implement the task.",
        workspace: "/tmp/worktree",
        auth: { mode: "api-key-env", environmentVariable: "OPENAI_API_KEY" },
        transport: { kind: "websocket" },
        options: {},
        continuation: null,
      },
    });
    expect(JSON.stringify(command)).not.toContain("sk-secret");
  });

  test("builds isolated resume and cancellation commands", () => {
    const snapshot = { version: 1, history: [] };
    const start = createTurnStartCommand({
      commandId: "start-command",
      requestId: "request-1",
      prompt: "Continue.",
      workspace: "/tmp/worktree",
      auth: { mode: "chatgpt", authFile: "/tmp/auth.json" },
      options: { instructions: null, thinking: "high", reasoningMode: "pro", fastMode: true },
      continuation: { mode: "resume", snapshot },
    });
    expect(start.data.continuation).toEqual({ mode: "resume", snapshot });
    expect(start.data.continuation.snapshot).not.toBe(snapshot);

    expect(createTurnCancelCommand({ commandId: "cancel-1", requestId: "request-1", reason: "timeout" })).toEqual({
      protocol: "smithers.nanocodex",
      version: 1,
      type: "turn.cancel",
      commandId: "cancel-1",
      requestId: "request-1",
      data: { reason: "timeout" },
    });
    expect(
      createTurnCancelCommand({
        commandId: "cancel-2",
        requestId: "request-1",
        sessionId: "session-1",
      }),
    ).toMatchObject({ sessionId: "session-1", data: {} });
  });

  test("implements exact v1 null and omission semantics", () => {
    const start = createTurnStartCommand({
      commandId: "start-command",
      requestId: "request-1",
      prompt: "task",
      workspace: "/tmp/worktree",
      auth: { mode: "chatgpt", authFile: null },
      options: { instructions: null, thinking: null, reasoningMode: null, fastMode: null },
      continuation: null,
    });
    expect(start.data.auth.authFile).toBeNull();
    expect(start.data.options).toEqual({ instructions: null, thinking: null, reasoningMode: null, fastMode: null });
    expect(
      createTurnCancelCommand({ commandId: "cancel", requestId: "request", sessionId: null, reason: null }),
    ).toEqual({
      protocol: "smithers.nanocodex",
      version: 1,
      type: "turn.cancel",
      commandId: "cancel",
      requestId: "request",
      data: {},
    });
    expect(() =>
      createTurnStartCommand({
        commandId: "start",
        requestId: "request",
        prompt: "task",
        workspace: "/tmp/worktree",
        auth: { mode: "chatgpt" },
        options: null,
      }),
    ).toThrow("plain object");
  });

  test("rejects unsafe correlation, workspace, auth, option, and continuation values", () => {
    const valid = {
      commandId: "start-command",
      requestId: "request-1",
      prompt: "task",
      workspace: "/tmp/worktree",
      auth: { mode: "api-key-env", environmentVariable: "OPENAI_API_KEY" },
    };
    expect(() => createTurnStartCommand({ ...valid, commandId: "contains space" })).toThrow("safe ASCII");
    expect(() => createTurnStartCommand({ ...valid, workspace: "relative/path" })).toThrow("absolute");
    expect(() => createTurnStartCommand({ ...valid, prompt: " \n\t " })).toThrow("empty");
    expect(() =>
      createTurnStartCommand({ ...valid, auth: { mode: "api-key-env", environmentVariable: "BAD-NAME" } }),
    ).toThrow("environment variable");
    expect(() => createTurnStartCommand({ ...valid, options: { thinking: "ultra" } })).toThrow("thinking");
    expect(() => createTurnStartCommand({ ...valid, options: { model: "gpt-4o" } })).toThrow("model");
    expect(createTurnStartCommand({ ...valid, options: { model: "terra" } }).data.options.model).toBe("terra");
    expect(createTurnStartCommand({ ...valid, options: { model: "gpt-5.6-luna" } }).data.options.model).toBe(
      "gpt-5.6-luna",
    );
    expect(() => createTurnStartCommand({ ...valid, options: { instructions: "  " } })).toThrow("nonempty");
    expect(() => createTurnStartCommand({ ...valid, auth: { mode: "chatgpt", authFile: "relative.json" } })).toThrow(
      "absolute",
    );
    expect(() =>
      createTurnStartCommand({ ...valid, continuation: { mode: "fork", snapshot: { version: 1 } } }),
    ).toThrow("incompatible");
    expect(() =>
      createTurnCancelCommand({ commandId: "cancel", requestId: "request", reason: "x".repeat(127) + "é" }),
    ).toThrow("untrusted text");
    expect(() => createTurnCancelCommand({ commandId: "cancel", requestId: "request", reason: "line\nbreak" })).toThrow(
      "untrusted text",
    );
    expect(() => createTurnCancelCommand({ commandId: "cancel", requestId: "request", secret: "value" })).toThrow(
      "invalid field set",
    );
  });

  test("matches Rust Unicode whitespace and scalar-value semantics for every outbound string", () => {
    const valid = {
      commandId: "start-command",
      requestId: "request-1",
      prompt: "task",
      workspace: "/tmp/worktree",
      auth: { mode: "chatgpt" },
    };
    expect(() => createTurnStartCommand({ ...valid, prompt: "\u0085" })).toThrow("empty");
    expect(() => createTurnStartCommand({ ...valid, options: { instructions: "\u0085" } })).toThrow("nonempty");
    expect(createTurnStartCommand({ ...valid, prompt: "\ufeff" }).data.prompt).toBe("\ufeff");
    expect(createTurnStartCommand({ ...valid, options: { instructions: "\ufeff" } }).data.options.instructions).toBe(
      "\ufeff",
    );

    const invalidStarts = [
      { ...valid, prompt: "\ud800" },
      { ...valid, workspace: "/tmp/\udfff" },
      { ...valid, auth: { mode: "chatgpt", authFile: "/tmp/\ud800" } },
      { ...valid, options: { instructions: "text\udfff" } },
      { ...valid, continuation: { mode: "resume", snapshot: { value: "\ud800" } } },
      { ...valid, continuation: { mode: "resume", snapshot: { ["\udfff"]: true } } },
    ];
    for (const input of invalidStarts) {
      expect(() => createTurnStartCommand(input)).toThrow("unpaired UTF-16 surrogate");
    }
    expect(() =>
      createTurnCancelCommand({ commandId: "cancel", requestId: "request", reason: "cancel\ud800" }),
    ).toThrow("unpaired UTF-16 surrogate");
  });
});

describe("Nanocodex checkpoint codec", () => {
  const workspace = "/tmp/worktree";
  const fingerprint = createNanocodexPolicyFingerprint(null);

  function checkpoint() {
    return createNanocodexCheckpoint({
      snapshot: { version: 1, history: [{ role: "assistant", text: "done" }] },
      snapshotVersion: 1,
      canonicalWorkspace: workspace,
      policyFingerprint: fingerprint,
    });
  }

  test("defines the stable canonical stock policy fingerprint", () => {
    expect(createNanocodexPolicy()).toEqual({
      fingerprintVersion: 1,
      instructions: null,
      tools: {
        profile: "nanocodex-stock-0.5.0",
        codeMode: true,
        mcp: false,
        subagents: false,
      },
    });
    expect(fingerprint).toBe("sha256:1faa485a45bd4bf1977f3cfb92b66656e3be9e3348dcee9490c8b0f7eb47fbd4");
    expect(createNanocodexPolicyFingerprint("Follow the task exactly.")).not.toBe(fingerprint);
    expect(createNanocodexPolicyFingerprint("")).not.toBe(fingerprint);
    expect(() => createNanocodexPolicyFingerprint(undefined)).not.toThrow();
    expect(() => createNanocodexPolicyFingerprint(42)).toThrow("string or null");
  });

  test("matches every authoritative scalar-exact policy golden vector byte for byte", () => {
    const golden = JSON.parse(fixture("policy-fingerprint-v1.json"));
    expect(golden.algorithm).toBe("smithers.nanocodex.policy-fingerprint/1");
    for (const vector of golden.vectors) {
      const input = createNanocodexPolicyFingerprintInput(vector.instructions);
      expect(input.toString("utf8"), vector.name).toBe(vector.canonicalUtf8);
      expect(input.toString("hex"), vector.name).toBe(vector.canonicalUtf8Hex);
      expect(createNanocodexPolicyFingerprint(vector.instructions), vector.name).toBe(vector.fingerprint);
    }
    const raw = JSON.parse(golden.constructionChecks[0].rawPolicyJson);
    expect(raw.fingerprintVersion).toBe(1);
    expect(createNanocodexPolicyFingerprint(raw.instructions)).toBe(golden.constructionChecks[0].fingerprint);
    expect(golden.vectors.find((vector) => vector.name === "unicode-nfc").fingerprint).not.toBe(
      golden.vectors.find((vector) => vector.name === "unicode-nfd").fingerprint,
    );
  });

  test("rejects lone surrogates instead of hashing replacement or escaped code units", () => {
    for (const invalid of ["\ud800", "\udfff", `ok\ud800x`, `ok\udfff`]) {
      expect(() => createNanocodexPolicyFingerprintInput(invalid)).toThrow("unpaired UTF-16 surrogate");
      expect(() => createNanocodexPolicyFingerprint(invalid)).toThrow("unpaired UTF-16 surrogate");
      expect(() => createNanocodexPolicy(invalid)).toThrow("unpaired UTF-16 surrogate");
    }
    expect(() => createNanocodexPolicyFingerprint("🛠️")).not.toThrow();
  });

  test("advertises exact codec v1 production and resume-only consumption", () => {
    expect(NANOCODEX_CHECKPOINT_FORMATS).toEqual([{ codec: "nanocodex.session-snapshot", versions: [1] }]);
    expect(NANOCODEX_CHECKPOINT_CAPABILITIES).toEqual([
      { codec: "nanocodex.session-snapshot", versions: [1], modes: ["resume"] },
    ]);
    expect(Object.isFrozen(NANOCODEX_CHECKPOINT_FORMATS[0].versions)).toBe(true);
    expect(NANOCODEX_CHECKPOINT_CODEC).toBe("nanocodex.session-snapshot");
  });

  test("constructs an exact envelope and clones the opaque snapshot", () => {
    const snapshot = { version: 1, history: [{ role: "assistant", text: "done" }] };
    const created = createNanocodexCheckpoint({
      snapshot,
      snapshotVersion: 1,
      canonicalWorkspace: workspace,
      policyFingerprint: fingerprint,
    });
    expect(created).toEqual({
      codec: "nanocodex.session-snapshot",
      version: 1,
      payload: {
        bridgeProtocolVersion: 1,
        nanocodexVersion: NANOCODEX_VERSION,
        snapshotVersion: 1,
        model: "gpt-5.6-sol",
        canonicalWorkspace: workspace,
        policyFingerprint: fingerprint,
        nanocodexSnapshot: snapshot,
      },
    });
    expect(created.payload.nanocodexSnapshot).not.toBe(snapshot);
    expect(
      createNanocodexCheckpoint({
        snapshot,
        snapshotVersion: 1,
        canonicalWorkspace: workspace,
        policyFingerprint: fingerprint,
        model: "gpt-5.6-terra",
      }).payload.model,
    ).toBe("gpt-5.6-terra");
  });

  test("consumes the authoritative checkpoint fixture from the Smithers-owned copy", () => {
    const authoritative = JSON.parse(fixture("checkpoint-v1.json"));
    const validated = validateNanocodexCheckpoint(authoritative, {
      canonicalWorkspace: "/workspace",
      policyFingerprint: createNanocodexPolicyFingerprint(null),
    });
    expect(validated).toEqual(authoritative);
    expect(validated).not.toBe(authoritative);
    expect(authoritative.payload.model).toBeUndefined();
  });

  test("rejects a 0.0.1 / Nanocodex 0.3.0 envelope before resume", () => {
    const rejected = JSON.parse(fixture("checkpoint-v0.0.1-rejected.json"));
    expect(rejected.payload.nanocodexVersion).toBe("0.3.0");
    expect(() =>
      validateNanocodexCheckpoint(rejected, {
        canonicalWorkspace: "/workspace",
        policyFingerprint: createNanocodexPolicyFingerprint(null),
      }),
    ).toThrow("library version");
  });

  test("accepts both shipped rustc targets at the protocol layer", () => {
    for (const target of NANOCODEX_SHIPPED_TARGETS) {
      const value = capabilities();
      value.target = target;
      expect(validateNanocodexCapabilities(value).target).toBe(target);
    }
  });

  test("validates and isolates one same-workspace resume snapshot", () => {
    const source = checkpoint();
    const validated = validateNanocodexCheckpoint(source, {
      mode: "resume",
      canonicalWorkspace: workspace,
      policyFingerprint: fingerprint,
    });
    expect(validated).toEqual(source);
    expect(validated).not.toBe(source);
    expect(validated.payload).not.toBe(source.payload);

    const resumed = getNanocodexResumeSnapshot(source, {
      canonicalWorkspace: workspace,
      policyFingerprint: fingerprint,
    });
    expect(resumed).toEqual(source.payload.nanocodexSnapshot);
    expect(resumed).not.toBe(source.payload.nanocodexSnapshot);
  });

  test("fails closed on every continuation compatibility binding", () => {
    const mutations = [
      ["codec", (value) => (value.codec = "other")],
      ["codec version", (value) => (value.version = 2)],
      ["bridge protocol", (value) => (value.payload.bridgeProtocolVersion = 2)],
      ["library version", (value) => (value.payload.nanocodexVersion = "0.3.0")],
      ["snapshot version", (value) => (value.payload.snapshotVersion = 2)],
      ["model", (value) => (value.payload.model = "gpt-4o")],
      ["workspace", (value) => (value.payload.canonicalWorkspace = "/tmp/other")],
      ["policy", (value) => (value.payload.policyFingerprint = createNanocodexPolicyFingerprint("other"))],
      ["exact payload", (value) => (value.payload.extra = true)],
    ];
    for (const [, mutate] of mutations) {
      const value = checkpoint();
      mutate(value);
      expect(() =>
        validateNanocodexCheckpoint(value, {
          canonicalWorkspace: workspace,
          policyFingerprint: fingerprint,
        }),
      ).toThrow();
    }

    expect(() =>
      validateNanocodexCheckpoint(checkpoint(), {
        mode: "fork",
        canonicalWorkspace: workspace,
        policyFingerprint: fingerprint,
      }),
    ).toThrow("resume mode only");
    expect(() =>
      validateNanocodexCheckpoint(checkpoint(), {
        canonicalWorkspace: "relative/workspace",
        policyFingerprint: fingerprint,
      }),
    ).toThrow("absolute");
  });

  test("integrates strict JSON cloning and the configured/system byte ceilings", () => {
    const source = checkpoint();
    const encodedBytes = Buffer.byteLength(JSON.stringify(source), "utf8");
    expect(() =>
      validateNanocodexCheckpoint(source, {
        canonicalWorkspace: workspace,
        policyFingerprint: fingerprint,
        maxBytes: encodedBytes - 1,
      }),
    ).toThrow(`exceeds ${encodedBytes - 1} bytes`);
    expect(() =>
      validateNanocodexCheckpoint(source, {
        canonicalWorkspace: workspace,
        policyFingerprint: fingerprint,
        maxBytes: DEFAULT_AGENT_CHECKPOINT_MAX_BYTES + 1,
      }),
    ).toThrow("system ceiling");

    const invalidValues = [undefined, NaN, Infinity, -0, Number.MAX_SAFE_INTEGER + 1];
    for (const invalid of invalidValues) {
      const value = checkpoint();
      value.payload.nanocodexSnapshot = { invalid };
      expect(() =>
        validateNanocodexCheckpoint(value, {
          canonicalWorkspace: workspace,
          policyFingerprint: fingerprint,
        }),
      ).toThrow("stable JSON");
    }

    const cycle = checkpoint();
    cycle.payload.nanocodexSnapshot.self = cycle.payload.nanocodexSnapshot;
    expect(() =>
      validateNanocodexCheckpoint(cycle, {
        canonicalWorkspace: workspace,
        policyFingerprint: fingerprint,
      }),
    ).toThrow("cycle");
  });

  test("reserves the complete minimal resume envelope at exact structural boundaries", () => {
    const exactDepthSnapshot = { nested: nestedJsonArray(NANOCODEX_LIMITS.maxJsonDepth - 5) };
    expect(() =>
      createNanocodexCheckpoint({
        snapshot: exactDepthSnapshot,
        snapshotVersion: 1,
        canonicalWorkspace: workspace,
        policyFingerprint: fingerprint,
      }),
    ).not.toThrow();
    expect(() =>
      createNanocodexCheckpoint({
        snapshot: { nested: nestedJsonArray(NANOCODEX_LIMITS.maxJsonDepth - 4) },
        snapshotVersion: 1,
        canonicalWorkspace: workspace,
        policyFingerprint: fingerprint,
      }),
    ).toThrow("resume-structure limits");

    const baseSnapshot = { left: [], right: [] };
    const baseResumeCommand = createTurnStartCommand({
      commandId: "resume",
      requestId: "resume",
      prompt: "r",
      workspace,
      auth: { mode: "chatgpt", authFile: null },
      options: { instructions: null, model: null, thinking: null, reasoningMode: null, fastMode: null },
      continuation: { mode: "resume", snapshot: baseSnapshot },
    });
    const addedNullNodes = NANOCODEX_LIMITS.maxJsonNodes - jsonNodeCount(baseResumeCommand);
    const exactNodeSnapshot = {
      left: Array(NANOCODEX_LIMITS.maxJsonArrayElements).fill(null),
      right: Array(addedNullNodes - NANOCODEX_LIMITS.maxJsonArrayElements).fill(null),
    };
    expect(
      jsonNodeCount(
        createTurnStartCommand({
          commandId: "resume",
          requestId: "resume",
          prompt: "r",
          workspace,
          auth: { mode: "chatgpt", authFile: null },
          options: { instructions: null, model: null, thinking: null, reasoningMode: null, fastMode: null },
          continuation: { mode: "resume", snapshot: exactNodeSnapshot },
        }),
      ),
    ).toBe(NANOCODEX_LIMITS.maxJsonNodes);
    expect(() =>
      createNanocodexCheckpoint({
        snapshot: exactNodeSnapshot,
        snapshotVersion: 1,
        canonicalWorkspace: workspace,
        policyFingerprint: fingerprint,
      }),
    ).not.toThrow();
    exactNodeSnapshot.right.push(null);
    expect(() =>
      createNanocodexCheckpoint({
        snapshot: exactNodeSnapshot,
        snapshotVersion: 1,
        canonicalWorkspace: workspace,
        policyFingerprint: fingerprint,
      }),
    ).toThrow("resume-structure limits");
  });

  test("rejects one-over checkpoint collection and Unicode scalar boundaries", () => {
    expect(() =>
      createNanocodexCheckpoint({
        snapshot: {
          left: Array(NANOCODEX_LIMITS.maxJsonArrayElements).fill(null),
          right: Array(NANOCODEX_LIMITS.maxJsonArrayElements).fill(null),
        },
        snapshotVersion: 1,
        canonicalWorkspace: workspace,
        policyFingerprint: fingerprint,
      }),
    ).toThrow("total-node limit");

    expect(() =>
      createNanocodexCheckpoint({
        snapshot: { values: Array(NANOCODEX_LIMITS.maxJsonArrayElements + 1).fill(null) },
        snapshotVersion: 1,
        canonicalWorkspace: workspace,
        policyFingerprint: fingerprint,
      }),
    ).toThrow("element limit");

    for (const snapshot of [{ invalid: "\ud800" }, { ["\udfff"]: true }]) {
      expect(() =>
        createNanocodexCheckpoint({
          snapshot,
          snapshotVersion: 1,
          canonicalWorkspace: workspace,
          policyFingerprint: fingerprint,
        }),
      ).toThrow("unpaired UTF-16 surrogate");
    }
  });

  test("accepts an exact 15 MiB opaque snapshot inside the 16 MiB Smithers envelope", () => {
    const snapshot = jsonObjectWithEncodedBytes(NANOCODEX_LIMITS.maxSnapshotBytes);
    const accepted = createNanocodexCheckpoint({
      snapshot,
      snapshotVersion: 1,
      canonicalWorkspace: workspace,
      policyFingerprint: fingerprint,
    });
    expect(Buffer.byteLength(JSON.stringify(accepted.payload.nanocodexSnapshot), "utf8")).toBe(
      NANOCODEX_LIMITS.maxSnapshotBytes,
    );
    expect(Buffer.byteLength(JSON.stringify(accepted), "utf8")).toBeLessThan(DEFAULT_AGENT_CHECKPOINT_MAX_BYTES);

    expect(() =>
      createNanocodexCheckpoint({
        snapshot: jsonObjectWithEncodedBytes(NANOCODEX_LIMITS.maxSnapshotBytes + 1),
        snapshotVersion: 1,
        canonicalWorkspace: workspace,
        policyFingerprint: fingerprint,
      }),
    ).toThrow("15728640-byte protocol ceiling");
  });

  test("does not include secret-bearing rejected checkpoint values in errors", () => {
    const sentinel = "checkpoint-secret-sentinel";
    const invalid = checkpoint();
    invalid.codec = sentinel;
    try {
      validateNanocodexCheckpoint(invalid, {
        canonicalWorkspace: workspace,
        policyFingerprint: fingerprint,
      });
      throw new Error("expected validation to fail");
    } catch (error) {
      expect(String(error)).not.toContain(sentinel);
      expect(JSON.stringify(error)).not.toContain(sentinel);
    }
  });
});
