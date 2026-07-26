import { describe, expect, test } from "bun:test";
import { GatewayExtensions, extensionMethodName, isExtensionMethod } from "../src/GatewayExtensions.js";

describe("GatewayExtensions branch coverage", () => {
  test("resolve exercises every kind and fallback + miss branch", () => {
    const registry = new GatewayExtensions();
    registry.register("full", {
      defaultScope: "run:admin",
      resources: { res: { handler: () => 1 } },
      actions: { act: { handler: () => 2 } },
      streams: { str: { subscribe: () => () => {} } },
    });
    // resource with defaultScope fallback
    expect(registry.resolve("ext.full.res")?.scope).toBe("run:admin");
    // action with defaultScope fallback
    expect(registry.resolve("ext.full.act")?.scope).toBe("run:admin");
    // stream with defaultScope fallback
    expect(registry.resolve("ext.stream.full.str")?.scope).toBe("run:admin");
    // unknown key under a known namespace -> undefined (falls through resource+action)
    expect(registry.resolve("ext.full.nope")).toBeUndefined();
    // unknown namespace
    expect(registry.resolve("ext.missing.k")).toBeUndefined();
    // stream with unknown namespace/key
    expect(registry.resolve("ext.stream.missing.k")).toBeUndefined();
    // non-string method
    expect(registry.resolve(123)).toBeUndefined();
    // malformed stream method (trailing dot)
    expect(registry.resolve("ext.stream.full.")).toBeUndefined();
    expect(registry.resolve("ext.stream..str")).toBeUndefined();
  });

  test("resolve falls back to run:read / run:write defaults when no defaultScope", () => {
    const registry = new GatewayExtensions();
    registry.register("nd", {
      resources: { res: { handler: () => 1 } },
      actions: { act: { handler: () => 2 } },
      streams: { str: { subscribe: () => {} } },
    });
    expect(registry.resolve("ext.nd.res")?.scope).toBe("run:read");
    expect(registry.resolve("ext.nd.act")?.scope).toBe("run:write");
    expect(registry.resolve("ext.stream.nd.str")?.scope).toBe("run:read");
  });

  test("requiredScopeForMethod and helpers", () => {
    const registry = new GatewayExtensions();
    registry.register("h", { resources: { r: { scope: "cron:read", handler: () => 1 } } });
    expect(registry.requiredScopeForMethod("ext.h.r")).toBe("cron:read");
    expect(registry.requiredScopeForMethod("ext.h.missing")).toBeUndefined();
    expect(registry.list().map((e) => e.namespace)).toEqual(["h"]);
    expect(extensionMethodName("ns", "resource", "k")).toBe("ext.ns.k");
    expect(extensionMethodName("ns", "action", "k")).toBe("ext.ns.k");
    expect(extensionMethodName("ns", "stream", "k")).toBe("ext.stream.ns.k");
    expect(isExtensionMethod("ext.a.b")).toBe(true);
    expect(isExtensionMethod("nope")).toBe(false);
    expect(isExtensionMethod(42)).toBe(false);
  });

  test("register enforces scope + identifier validation branches", () => {
    const registry = new GatewayExtensions();
    expect(() => registry.register("bad", { defaultScope: "moon:read" })).toThrow(/GatewayScope/);
    expect(() => registry.register("s2", { streams: { t: { scope: "moon:read", subscribe: () => {} } } })).toThrow(
      /GatewayScope/,
    );
    expect(() => registry.register("s3", { actions: { a: { scope: "moon:read", handler: () => 1 } } })).toThrow(
      /GatewayScope/,
    );
    expect(() => registry.register("s4", { streams: { t: { subscribe: "no" } } })).toThrow(/subscribe function/);
    expect(() => registry.register("s5", null)).toThrow(/definition is required/);
    expect(() => registry.register("s6", 5)).toThrow(/definition is required/);
  });
});
