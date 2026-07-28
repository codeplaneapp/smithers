import { describe, expect, test } from "bun:test";
import {
  buildChatLines,
  chatLineFromFrame,
  chatLinesFromFrame,
  logLineFromFrame,
  type RunEventFrame,
} from "../src/events.ts";
import {
  asArray,
  asBool,
  asNumber,
  asString,
  camelKey,
  isRecord,
  normalizeRow,
  parseMaybeJson,
  rowOf,
  strings,
  unwrapRow,
} from "../src/rows.ts";
import { paramFromUrl, runIdFromUrl, workflowUiHref } from "../src/url.ts";

function frame(event: string, payload: unknown, seq = 1): RunEventFrame {
  return { type: "event", event, payload, seq, stateVersion: 0 };
}

function wrapped(event: string, payload: unknown, seq = 1): RunEventFrame {
  return frame("run.event", { streamId: "run-1", seq, event, payload }, seq);
}

describe("rows", () => {
  test("isRecord", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord("x")).toBe(false);
    expect(isRecord(1)).toBe(false);
  });

  test("rowOf passes a bare row through", () => {
    const row = { status: "ok" };
    expect(rowOf(row)).toBe(row);
  });

  test("rowOf unwraps a { row } envelope", () => {
    const row = { status: "ok" };
    expect(rowOf({ row, schema: "v1" })).toBe(row);
  });

  test("rowOf unwraps { data: { row } }", () => {
    const row = { status: "ok" };
    expect(rowOf({ data: { row } })).toBe(row);
  });

  test("rowOf unwraps { data: <row> }", () => {
    const row = { status: "ok" };
    expect(rowOf({ data: row })).toBe(row);
  });

  test("rowOf unwraps nested data layers", () => {
    const row = { status: "ok" };
    expect(rowOf({ data: { data: { row } } })).toBe(row);
  });

  test("rowOf returns undefined for non-records", () => {
    expect(rowOf(undefined)).toBe(undefined);
    expect(rowOf(null)).toBe(undefined);
    expect(rowOf("str")).toBe(undefined);
    expect(rowOf([1, 2])).toBe(undefined);
  });

  test("unwrapRow is the rowOf alias", () => {
    const row = { a: 1 };
    expect(unwrapRow({ data: { row } })).toBe(row);
  });

  test("normalizeRow aliases snake_case keys to camelCase", () => {
    const row = normalizeRow({ run_id: "r1", created_at_ms: 7 });
    expect(row.run_id).toBe("r1");
    expect(row.runId).toBe("r1");
    expect(row.createdAtMs).toBe(7);
  });

  test("normalizeRow does not clobber an existing camelCase key", () => {
    const row = normalizeRow({ run_id: "snake", runId: "camel" });
    expect(row.runId).toBe("camel");
  });

  test("normalizeRow parses JSON-string array/object values", () => {
    const row = normalizeRow({ items: '["a","b"]', meta: '{"x":1}', note: "plain" });
    expect(row.items).toEqual(["a", "b"]);
    expect(row.meta).toEqual({ x: 1 });
    expect(row.note).toBe("plain");
  });

  test("normalizeRow unwraps envelopes first", () => {
    expect(normalizeRow({ row: { ticket_paths: '["a.md"]' } }).ticketPaths).toEqual(["a.md"]);
    expect(normalizeRow(undefined)).toEqual({});
  });

  test("parseMaybeJson", () => {
    expect(parseMaybeJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseMaybeJson("[1,2]")).toEqual([1, 2]);
    expect(parseMaybeJson("hello")).toBe("hello");
    expect(parseMaybeJson("{broken")).toBe("{broken");
    expect(parseMaybeJson(42)).toBe(42);
    expect(parseMaybeJson(null)).toBe(null);
  });

  test("camelKey", () => {
    expect(camelKey("created_at_ms")).toBe("createdAtMs");
    expect(camelKey("node_id")).toBe("nodeId");
    expect(camelKey("plain")).toBe("plain");
    expect(camelKey("_leading")).toBe("Leading");
  });

  test("asString", () => {
    expect(asString("x")).toBe("x");
    expect(asString(5)).toBe("5");
    expect(asString(undefined)).toBe("");
    expect(asString(null)).toBe("");
    expect(asString(true)).toBe("true");
  });

  test("asArray", () => {
    expect(asArray([1])).toEqual([1]);
    expect(asArray("x")).toEqual([]);
    expect(asArray(undefined)).toEqual([]);
  });

  test("asNumber", () => {
    expect(asNumber(3)).toBe(3);
    expect(asNumber(0)).toBe(0);
    expect(asNumber("3")).toBe(undefined);
    expect(asNumber(Number.NaN)).toBe(undefined);
  });

  test("asBool coerces 0/1 and true/false strings", () => {
    expect(asBool(true)).toBe(true);
    expect(asBool(false)).toBe(false);
    expect(asBool(1)).toBe(true);
    expect(asBool(0)).toBe(false);
    expect(asBool("true")).toBe(true);
    expect(asBool("false")).toBe(false);
    expect(asBool("yes")).toBe(undefined);
    expect(asBool(2)).toBe(undefined);
    expect(asBool(undefined)).toBe(undefined);
  });

  test("strings", () => {
    expect(strings(["a", "", "b"])).toEqual(["a", "b"]);
    expect(strings("nope")).toEqual([]);
    expect(strings([1, "x"])).toEqual(["1", "x"]);
  });

  test("useRow pure unwrap pipeline (rowOf + normalizeRow)", () => {
    // The hook's memoized transform is exactly rowOf + normalizeRow over
    // useGatewayNodeOutput's data; pin the combined behavior here.
    const data = { data: { row: { build_passed: 1, files: '["a.ts"]' } } };
    const row = normalizeRow(rowOf(data));
    expect(row.buildPassed).toBe(1);
    expect(asBool(row.buildPassed)).toBe(true);
    expect(row.files).toEqual(["a.ts"]);
  });
});

describe("url", () => {
  test("paramFromUrl/runIdFromUrl are SSR-safe without a window", () => {
    // The bun test runner has no browser window unless happy-dom is registered
    // by the test file; this file registers none.
    if (typeof window === "undefined") {
      expect(paramFromUrl("runId")).toBe(undefined);
      expect(runIdFromUrl()).toBe(undefined);
    } else {
      expect(typeof runIdFromUrl()).toBe(typeof runIdFromUrl());
    }
  });

  test("workflowUiHref strips the current workflow segment", () => {
    expect(workflowUiHref("docs-driven-development", "run 1", "/workflows/create-workflow")).toBe(
      "/workflows/docs-driven-development?runId=run%201",
    );
  });

  test("workflowUiHref keeps a non-workflow base path", () => {
    expect(workflowUiHref("other", "r", "/ui")).toBe("/ui/workflows/other?runId=r");
  });
});

describe("events chat decoders", () => {
  test("chatLineFromFrame decodes task.output", () => {
    expect(chatLineFromFrame(frame("task.output", { nodeId: "work", output: "hello" }))).toEqual({
      who: "work",
      text: "hello",
    });
  });

  test("chatLineFromFrame decodes agent.trace", () => {
    const payload = { nodeId: "review", trace: { payload: { text: "thinking" } } };
    expect(chatLineFromFrame(frame("agent.trace", payload))).toEqual({ who: "review", text: "thinking" });
  });

  test("chatLineFromFrame returns null for non-chat events", () => {
    expect(chatLineFromFrame(frame("node.started", { nodeId: "a" }))).toBe(null);
    expect(chatLineFromFrame(frame("task.output", { nodeId: "a", output: "  " }))).toBe(null);
  });

  test("frames double-wrapped in run.event decode the same", () => {
    expect(chatLineFromFrame(wrapped("task.output", { nodeId: "w", output: "hi" }))).toEqual({
      who: "w",
      text: "hi",
    });
    expect(chatLinesFromFrame(wrapped("task.output", { nodeId: "w", output: "hi" }))).toEqual([
      { who: "w", text: "hi", kind: "output" },
    ]);
  });

  test("chatLinesFromFrame expands an agent.session transcript", () => {
    const payload = {
      nodeId: "work",
      transcript: [
        { role: "user", content: "do the thing" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "working on it" },
            { type: "tool_use", name: "bash" },
            { type: "tool_result", content: "noise" },
          ],
        },
        { role: "assistant", content: [{ type: "reasoning", text: "hmm" }] },
      ],
    };
    expect(chatLinesFromFrame(frame("agent.session", payload))).toEqual([
      { who: "user", role: "user", text: "do the thing", kind: "message" },
      { who: "assistant", role: "assistant", text: "working on it\n↗ bash", kind: "message" },
      { who: "assistant", role: "assistant", text: "hmm", kind: "message" },
    ]);
  });

  test("chatLinesFromFrame decodes agent.event action envelopes", () => {
    const message = frame("agent.event", {
      nodeId: "n1",
      engine: "codex",
      event: {
        type: "action",
        message: "I did it",
        entryType: "message",
        action: { kind: "exec", detail: { type: "agent_message" } },
      },
    });
    expect(chatLinesFromFrame(message)).toEqual([
      { who: "codex", role: "assistant", text: "I did it", kind: "message" },
    ]);

    const tool = frame("agent.event", {
      nodeId: "n1",
      event: { type: "action", message: "ran ls", action: { kind: "command", detail: { type: "exec" } } },
    });
    expect(chatLinesFromFrame(tool)).toEqual([]);

    const completed = frame("agent.event", {
      nodeId: "n1",
      event: { type: "completed", answer: "final answer" },
    });
    expect(chatLinesFromFrame(completed)).toEqual([
      { who: "n1", role: "assistant", text: "final answer", kind: "message" },
    ]);

    const reasoning = frame("agent.event", {
      nodeId: "n1",
      event: { type: "action", message: "pondering", action: { kind: "reasoning" } },
    });
    expect(chatLinesFromFrame(reasoning)).toEqual([
      { who: "n1", role: "reasoning", text: "pondering", kind: "message" },
    ]);
  });

  test("buildChatLines keeps the longest cumulative transcript per session", () => {
    const short = frame(
      "agent.session",
      { nodeId: "w", sessionId: "s1", transcript: [{ role: "user", content: "one" }] },
      1,
    );
    const long = frame(
      "agent.session",
      {
        nodeId: "w",
        sessionId: "s1",
        transcript: [
          { role: "user", content: "one" },
          { role: "assistant", content: "two" },
        ],
      },
      2,
    );
    const lines = buildChatLines([short, long]);
    expect(lines.map((line) => line.text)).toEqual(["one", "two"]);
  });

  test("buildChatLines drops a completed answer already in the transcript", () => {
    const session = frame(
      "agent.session",
      { nodeId: "w", transcript: [{ role: "assistant", content: "done already" }] },
      1,
    );
    const completed = frame("agent.event", { nodeId: "w", event: { type: "completed", answer: "done already" } }, 2);
    const fresh = frame("agent.event", { nodeId: "w", event: { type: "completed", answer: "brand new" } }, 3);
    expect(buildChatLines([session, completed, fresh]).map((line) => line.text)).toEqual(["done already", "brand new"]);
  });

  test("buildChatLines keeps separate sessions separate", () => {
    const a = frame(
      "agent.session",
      { nodeId: "audit", transcript: [{ role: "assistant", content: "audit says" }] },
      1,
    );
    const b = frame("agent.session", { nodeId: "work", transcript: [{ role: "assistant", content: "work says" }] }, 2);
    expect(buildChatLines([b, a]).map((line) => line.text)).toEqual(["audit says", "work says"]);
  });
});

describe("events logLineFromFrame", () => {
  test("decodes node.started with tone", () => {
    expect(logLineFromFrame(frame("node.started", { nodeId: "work" }, 4))).toEqual({
      seq: 4,
      event: "node.started",
      node: "work",
      detail: "Started",
      tone: "",
    });
  });

  test("decodes node.finished with status and duration", () => {
    const line = logLineFromFrame(frame("node.finished", { nodeId: "work", status: "ok", durationMs: 1500 }, 5));
    expect(line).toEqual({
      seq: 5,
      event: "node.finished",
      node: "work",
      detail: "Finished · Complete · 1.5 s",
      tone: "ok",
    });
  });

  test("decodes node.failed as bad", () => {
    const line = logLineFromFrame(frame("node.failed", { nodeId: "work", message: "boom" }));
    expect(line?.tone).toBe("bad");
    expect(line?.detail).toBe("Failed · boom");
  });

  test("decodes run.completed", () => {
    const line = logLineFromFrame(frame("run.completed", { status: "done", durationMs: 61_000 }));
    expect(line?.detail).toBe("Done · 1 min 1 s");
    expect(line?.tone).toBe("ok");
  });

  test("returns null for heartbeats", () => {
    expect(logLineFromFrame(frame("run.heartbeat", {}))).toBe(null);
    expect(logLineFromFrame(frame("task.heartbeat", {}))).toBe(null);
  });

  test("summarizes structured task.output", () => {
    const line = logLineFromFrame(
      frame("task.output", { nodeId: "triage", output: '{"status":"ok","tickets":["a","b"]}' }),
    );
    expect(line?.detail).toBe("Complete · 2 tickets");
  });

  test("decodes agent.session as a message count", () => {
    const line = logLineFromFrame(frame("agent.session", { nodeId: "w", transcript: [{}, {}, {}] }));
    expect(line?.detail).toBe("3 messages");
  });

  test("decodes agent.event action and completed", () => {
    const action = logLineFromFrame(
      frame("agent.event", {
        nodeId: "w",
        event: { type: "action", message: "ran tests", action: { kind: "command" } },
      }),
    );
    expect(action?.detail).toBe("Command: ran tests");

    const completed = logLineFromFrame(
      frame("agent.event", { nodeId: "w", event: { type: "completed", answer: "shipped" } }),
    );
    expect(completed?.detail).toBe("Completed: shipped");
  });

  test("falls back to status/message for unknown events", () => {
    const line = logLineFromFrame(frame("approval.requested", { nodeId: "gate", message: "needs sign-off" }));
    expect(line?.detail).toBe("needs sign-off");
  });

  test("double-wrapped frames decode", () => {
    const line = logLineFromFrame(wrapped("node.started", { nodeId: "w" }, 9));
    expect(line?.seq).toBe(9);
    expect(line?.event).toBe("node.started");
  });
});
