import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  ensureMcpClient,
  extension,
  resetMcpStateForTesting,
  setMcpConnectionFactoryForTesting,
} from "../src/extension.js";

// Drain the microtask queue so the fully-resolved (no I/O, no timers) MCP
// bootstrap + tool registration chain settles deterministically.
async function flushMicrotasks() {
  for (let i = 0; i < 25; i++) {
    await Promise.resolve();
  }
}

type FakeTool = { name: string; description?: string };

function makeFakeCtx() {
  return {
    hasUI: false,
    ui: {
      notify() {},
      setStatus() {},
      custom: async () => {},
      input: async () => undefined,
      select: async () => undefined,
      confirm: async () => false,
    },
  };
}

type FakePi = {
  api: Parameters<typeof extension>[0];
  handlers: Map<string, (...args: any[]) => any>;
  registeredTools: Array<{ name: string }>;
};

function makeFakePi(): FakePi {
  const handlers = new Map<string, (...args: any[]) => any>();
  const registeredTools: Array<{ name: string }> = [];
  const api = {
    registerFlag() {},
    getFlag() {
      return undefined;
    },
    on(event: string, handler: (...args: any[]) => any) {
      handlers.set(event, handler);
    },
    registerTool(tool: { name: string }) {
      registeredTools.push(tool);
    },
    registerCommand() {},
    registerMessageRenderer() {},
    sendUserMessage() {},
  };
  return { api: api as unknown as Parameters<typeof extension>[0], handlers, registeredTools };
}

describe("pi-plugin MCP lifecycle", () => {
  beforeEach(() => {
    resetMcpStateForTesting();
    setMcpConnectionFactoryForTesting(undefined);
  });

  afterEach(() => {
    resetMcpStateForTesting();
    setMcpConnectionFactoryForTesting(undefined);
  });

  test("concurrent ensureMcpClient callers spawn and connect exactly once", async () => {
    let factoryCalls = 0;
    setMcpConnectionFactoryForTesting(async () => {
      factoryCalls++;
      const transport = { close: async () => {} };
      const client = {
        async listTools() {
          return { tools: [] as FakeTool[] };
        },
      } as unknown as Client;
      return { client, transport };
    });

    const [a, b, c] = await Promise.all([ensureMcpClient(), ensureMcpClient(), ensureMcpClient()]);

    expect(factoryCalls).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  test("session_shutdown closes the transport and lets a later session_start re-register", async () => {
    let factoryCalls = 0;
    const closeCounts: number[] = [];
    setMcpConnectionFactoryForTesting(async () => {
      const index = factoryCalls++;
      closeCounts[index] = 0;
      const transport = {
        close: async () => {
          closeCounts[index]++;
        },
      };
      const client = {
        async listTools() {
          return { tools: [{ name: "list_runs", description: "List runs" }] as FakeTool[] };
        },
      } as unknown as Client;
      return { client, transport };
    });

    const pi = makeFakePi();
    extension(pi.api);
    const start = pi.handlers.get("session_start")!;
    const shutdown = pi.handlers.get("session_shutdown")!;
    expect(start).toBeDefined();
    expect(shutdown).toBeDefined();

    // First session spawns one connection and registers its tools.
    await start(undefined, makeFakeCtx());
    await flushMicrotasks();
    expect(factoryCalls).toBe(1);
    expect(pi.registeredTools.map((tool) => tool.name)).toContain("smithers_list_runs");

    // Shutdown closes the live transport and resets the registration caches.
    pi.registeredTools.length = 0;
    await shutdown();
    expect(closeCounts[0]).toBe(1);

    // A later session spawns a fresh subprocess and re-registers the tools,
    // proving the dead client was dropped and mcpToolsRegistered was reset.
    await start(undefined, makeFakeCtx());
    await flushMicrotasks();
    expect(factoryCalls).toBe(2);
    expect(closeCounts[0]).toBe(1);
    expect(pi.registeredTools.map((tool) => tool.name)).toContain("smithers_list_runs");

    // Tidy up the timer the second session armed.
    await shutdown();
  });

  test("before_agent_start does not throw when the MCP bootstrap fails", async () => {
    setMcpConnectionFactoryForTesting(async () => {
      throw new Error("bun not found");
    });

    const pi = makeFakePi();
    extension(pi.api);
    const beforeAgentStart = pi.handlers.get("before_agent_start")!;
    expect(beforeAgentStart).toBeDefined();

    const result = await beforeAgentStart({ systemPrompt: "BASE PROMPT" });

    expect(result.systemPrompt).toContain("BASE PROMPT");
    // The agent-tool guidance is omitted while the MCP server is unreachable.
    expect(result.systemPrompt).not.toContain("### Tools (available to you, the agent)");
  });

  test("withMcpRetry reconnects once when a live MCP call fails mid-session", async () => {
    let factoryCalls = 0;
    const closeCounts: number[] = [];
    setMcpConnectionFactoryForTesting(async () => {
      const index = factoryCalls++;
      closeCounts[index] = 0;
      const transport = {
        close: async () => {
          closeCounts[index]++;
        },
      };
      const client = {
        async listTools() {
          // The first connection's live call rejects (subprocess died); the
          // connection withMcpRetry rebuilds answers successfully.
          if (index === 0) throw new Error("transport closed mid-session");
          return { tools: [{ name: "list_runs", description: "List runs" }] as FakeTool[] };
        },
      } as unknown as Client;
      return { client, transport };
    });

    const pi = makeFakePi();
    extension(pi.api);
    const beforeAgentStart = pi.handlers.get("before_agent_start")!;
    expect(beforeAgentStart).toBeDefined();

    const result = await beforeAgentStart({ systemPrompt: "BASE PROMPT" });

    // Recovered: exactly one rebuild (two connections), the dead transport was
    // closed once, and the guidance built from the healthy client shipped.
    expect(factoryCalls).toBe(2);
    expect(closeCounts[0]).toBe(1);
    expect(result.systemPrompt).toContain("### Tools (available to you, the agent)");
  });

  test("withMcpRetry gives up after the second failure without a third connection", async () => {
    let factoryCalls = 0;
    setMcpConnectionFactoryForTesting(async () => {
      factoryCalls++;
      const transport = { close: async () => {} };
      const client = {
        async listTools() {
          throw new Error("transport closed mid-session");
        },
      } as unknown as Client;
      return { client, transport };
    });

    const pi = makeFakePi();
    extension(pi.api);
    const beforeAgentStart = pi.handlers.get("before_agent_start")!;
    expect(beforeAgentStart).toBeDefined();

    const result = await beforeAgentStart({ systemPrompt: "BASE PROMPT" });

    // Retried exactly once (two connections), then propagated; before_agent_start
    // catches it and degrades instead of looping or spawning a third connection.
    expect(factoryCalls).toBe(2);
    expect(result.systemPrompt).toContain("BASE PROMPT");
    expect(result.systemPrompt).not.toContain("### Tools (available to you, the agent)");
  });
});
