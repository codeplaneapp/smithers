import { describe, expect, test } from "bun:test";
import {
  EXTENSION_PAYLOAD_MAX_BYTES,
  GatewayExtensions,
  extensionMethodName,
  isExtensionMethod,
} from "../src/GatewayExtensions.js";

describe("GatewayExtensions registry", () => {
  test("registers a namespace and resolves its resource", () => {
    const registry = new GatewayExtensions();
    registry.register("github", {
      defaultScope: "run:read",
      resources: {
        issue: {
          handler: () => ({ id: "1" }),
        },
      },
    });
    const resolved = registry.resolve("ext.github.issue");
    expect(resolved).toBeDefined();
    expect(resolved?.kind).toBe("resource");
    expect(resolved?.scope).toBe("run:read");
  });

  test("resolves actions and streams under distinct kinds", () => {
    const registry = new GatewayExtensions();
    registry.register("ops", {
      actions: { restart: { scope: "run:write", handler: () => null } },
      streams: { tail: { scope: "observability:read", subscribe: () => {} } },
    });
    expect(registry.resolve("ext.ops.restart")?.kind).toBe("action");
    expect(registry.resolve("ext.ops.restart")?.scope).toBe("run:write");
    expect(registry.resolve("ext.stream.ops.tail")?.kind).toBe("stream");
    expect(registry.resolve("ext.stream.ops.tail")?.scope).toBe("observability:read");
  });

  test("rejects duplicate namespace registration", () => {
    const registry = new GatewayExtensions();
    registry.register("dup", { resources: { a: { handler: () => 1 } } });
    expect(() =>
      registry.register("dup", { resources: { b: { handler: () => 2 } } }),
    ).toThrow(/already registered/i);
  });

  test("rejects a key registered as both resource and action in one namespace", () => {
    const registry = new GatewayExtensions();
    expect(() =>
      registry.register("clash", {
        resources: { x: { handler: () => 1 } },
        actions: { x: { handler: () => 1 } },
      }),
    ).toThrow(/declared as both/i);
  });

  test("rejects invalid namespace identifiers", () => {
    const registry = new GatewayExtensions();
    expect(() => registry.register("1bad", {})).toThrow(/match/i);
    expect(() => registry.register("BadCaps", {})).toThrow(/match/i);
    expect(() => registry.register("", {})).toThrow(/required/i);
    expect(() => registry.register("a".repeat(65), {})).toThrow(/exceeds/i);
  });

  test("rejects handlers that are not functions", () => {
    const registry = new GatewayExtensions();
    expect(() =>
      registry.register("noop", {
        resources: { broken: { handler: "not a fn" as unknown as () => unknown } },
      }),
    ).toThrow(/handler function/i);
  });

  test("rejects unknown scopes", () => {
    const registry = new GatewayExtensions();
    expect(() =>
      registry.register("bad", {
        resources: {
          x: { scope: "moon:read" as never, handler: () => 1 },
        },
      }),
    ).toThrow(/GatewayScope/i);
  });

  test("namespace-and-key resolution requires both halves", () => {
    const registry = new GatewayExtensions();
    registry.register("ns", { resources: { k: { handler: () => 1 } } });
    expect(registry.resolve("ext.ns.")).toBeUndefined();
    expect(registry.resolve("ext..k")).toBeUndefined();
    expect(registry.resolve("ext.ns")).toBeUndefined();
    expect(registry.resolve("notext.ns.k")).toBeUndefined();
  });

  test("requiredScopeForMethod falls back to namespace defaultScope", () => {
    const registry = new GatewayExtensions();
    registry.register("scoped", {
      defaultScope: "run:admin",
      resources: { thing: { handler: () => 1 } },
    });
    expect(registry.requiredScopeForMethod("ext.scoped.thing")).toBe("run:admin");
  });

  test("queries alias merges into resources", () => {
    const registry = new GatewayExtensions();
    registry.register("merged", {
      queries: { fromQuery: { handler: () => "q" } },
      resources: { fromResource: { handler: () => "r" } },
    });
    expect(registry.resolve("ext.merged.fromQuery")?.kind).toBe("resource");
    expect(registry.resolve("ext.merged.fromResource")?.kind).toBe("resource");
  });

  test("list() introspects registered namespaces", () => {
    const registry = new GatewayExtensions();
    registry.register("a", { resources: { r: { handler: () => 1 } } });
    registry.register("b", { actions: { act: { handler: () => 2 } } });
    const out = registry.list().sort((x, y) => x.namespace.localeCompare(y.namespace));
    expect(out).toEqual([
      {
        namespace: "a",
        title: undefined,
        description: undefined,
        defaultScope: undefined,
        resources: ["r"],
        actions: [],
        streams: [],
      },
      {
        namespace: "b",
        title: undefined,
        description: undefined,
        defaultScope: undefined,
        resources: [],
        actions: ["act"],
        streams: [],
      },
    ]);
  });
});

describe("extension method-name helpers", () => {
  test("extensionMethodName builds canonical methods", () => {
    expect(extensionMethodName("foo", "resource", "bar")).toBe("ext.foo.bar");
    expect(extensionMethodName("foo", "action", "bar")).toBe("ext.foo.bar");
    expect(extensionMethodName("foo", "stream", "bar")).toBe("ext.stream.foo.bar");
  });

  test("isExtensionMethod detects only the ext. prefix", () => {
    expect(isExtensionMethod("ext.foo.bar")).toBe(true);
    expect(isExtensionMethod("ext.stream.foo.bar")).toBe(true);
    expect(isExtensionMethod("launchRun")).toBe(false);
    expect(isExtensionMethod("extra.foo.bar")).toBe(false);
  });
});

describe("EXTENSION_PAYLOAD_MAX_BYTES constant", () => {
  test("is generous enough for typical UI payloads but bounded", () => {
    expect(EXTENSION_PAYLOAD_MAX_BYTES).toBeGreaterThanOrEqual(1024 * 1024);
    expect(EXTENSION_PAYLOAD_MAX_BYTES).toBeLessThanOrEqual(16 * 1024 * 1024);
  });
});
