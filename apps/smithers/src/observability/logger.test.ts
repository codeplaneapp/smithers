import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  REDACTED_HEADERS,
  emit,
  error as logError,
  info as logInfo,
  loggerDropsTotal,
  redactHeaders,
  redactUrl,
  setEmitter,
  withCorrelationContext,
} from "./logger";

let captured: string[] = [];

beforeEach(() => {
  captured = [];
  setEmitter((line) => captured.push(line));
  loggerDropsTotal.reset();
});

afterEach(() => {
  setEmitter(() => {});
  loggerDropsTotal.reset();
});

describe("redactHeaders", () => {
  test("redacts the documented sensitive headers", () => {
    const headers = new Headers({
      authorization: "Bearer secret",
      cookie: "session=abc",
      "x-smithers-key": "key123",
      "x-user-id": "42",
      "x-user-scopes": "run:write",
      "content-type": "application/json",
    });
    const out = redactHeaders(headers);
    expect(out["authorization"]).toBe("[redacted]");
    expect(out["cookie"]).toBe("[redacted]");
    expect(out["x-smithers-key"]).toBe("[redacted]");
    expect(out["x-user-id"]).toBe("[redacted]");
    expect(out["x-user-scopes"]).toBe("[redacted]");
    expect(out["content-type"]).toBe("application/json");
  });

  test("accepts plain object headers, plain array headers, and undefined", () => {
    expect(redactHeaders(undefined)).toEqual({});
    expect(
      redactHeaders([
        ["AUTHORIZATION", "Bearer x"],
        ["X-Foo", "bar"],
      ]),
    ).toEqual({ authorization: "[redacted]", "x-foo": "bar" });
    expect(
      redactHeaders({ authorization: "Bearer x", "x-foo": "bar" }),
    ).toEqual({ authorization: "[redacted]", "x-foo": "bar" });
  });

  test("REDACTED_HEADERS contract is stable", () => {
    expect(REDACTED_HEADERS).toContain("authorization");
    expect(REDACTED_HEADERS).toContain("cookie");
    expect(REDACTED_HEADERS).toContain("x-smithers-key");
  });
});

describe("redactUrl", () => {
  test("redacts oauth tokens in the query string", () => {
    const out = redactUrl(
      "https://example.com/cb?code=abc&state=xyz&access_token=def&safe=ok",
    );
    const url = new URL(out);
    expect(url.searchParams.get("code")).toBe("[redacted]");
    expect(url.searchParams.get("state")).toBe("[redacted]");
    expect(url.searchParams.get("access_token")).toBe("[redacted]");
    expect(url.searchParams.get("safe")).toBe("ok");
  });

  test("strips userinfo credentials", () => {
    const out = redactUrl("https://alice:hunter2@example.com/x");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("alice");
    expect(out).toContain("redacted");
  });

  test("returns input verbatim when it is not a URL", () => {
    expect(redactUrl("not a url")).toBe("not a url");
  });
});

describe("emit / level helpers", () => {
  test("info emits a JSON line containing level, message and fields", () => {
    logInfo("hello", { route: "/x", count: 3 }, "test");
    expect(captured).toHaveLength(1);
    const parsed = JSON.parse(captured[0]);
    expect(parsed.level).toBe("info");
    expect(parsed.message).toBe("hello");
    expect(parsed.component).toBe("test");
    expect(parsed.route).toBe("/x");
    expect(parsed.count).toBe(3);
  });

  test("error contains the message and any extra fields", () => {
    logError("boom", { code: "E_BAD" });
    expect(JSON.parse(captured[0]).level).toBe("error");
    expect(JSON.parse(captured[0]).code).toBe("E_BAD");
  });

  test("a throwing emitter is swallowed and bumps loggerDropsTotal(sink)", () => {
    setEmitter(() => {
      throw new Error("sink down");
    });
    expect(() => emit({ level: "info", message: "x" })).not.toThrow();
    expect(loggerDropsTotal.get({ reason: "sink" })).toBe(1);
  });

  test("a non-serializable field is swallowed and bumps loggerDropsTotal(serialize)", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() =>
      emit({ level: "info", message: "x", fields: { circular } }),
    ).not.toThrow();
    expect(loggerDropsTotal.get({ reason: "serialize" })).toBe(1);
  });

  test("withCorrelationContext is visible to imperative log calls", () => {
    withCorrelationContext({ runId: "run-1", nodeId: "node-1" }, () => {
      logInfo("correlated", { action: "sync" }, "test");
    });
    const parsed = JSON.parse(captured[0]);
    expect(parsed.runId).toBe("run-1");
    expect(parsed.nodeId).toBe("node-1");
    expect(parsed.action).toBe("sync");
  });
});
