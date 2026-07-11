import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { AnthropicAgent } from "../src/index.js";
import { createMcpToolset } from "../src/mcp/createMcpToolset.js";

const DEMO_SERVER = resolve(import.meta.dir, "fixtures", "demo-mcp-server.js");
const FLOOD_SERVER = resolve(import.meta.dir, "fixtures", "stderr-flood-mcp-server.js");
const PENDING_SERVER = resolve(import.meta.dir, "fixtures", "pending-mcp-server.js");

/** @param {Partial<import("../src/mcp/McpToolsetOptions")>} [options] */
function connectDemo(options) {
  return createMcpToolset({ command: "bun", args: [DEMO_SERVER] }, options);
}

const callOptions = { toolCallId: "test-call", messages: [] };

describe("createMcpToolset (real MCP server over stdio)", () => {
  test("projects an MCP server's tools into an AI SDK toolset", async () => {
    const toolset = await connectDemo();
    try {
      expect([...toolset.toolNames].sort()).toEqual(["add", "shout"]);
      expect(typeof toolset.tools.add.execute).toBe("function");
    } finally {
      await toolset.close();
    }
  });

  test("executes tools against the live server", async () => {
    const toolset = await connectDemo();
    try {
      expect(await toolset.tools.add.execute({ a: 2, b: 3 }, callOptions)).toBe("5");
      expect(await toolset.tools.shout.execute({ text: "hi" }, callOptions)).toBe("HI");
    } finally {
      await toolset.close();
    }
  });

  test("namePrefix and exclude curate the toolset", async () => {
    const toolset = await connectDemo({ namePrefix: "demo_", exclude: ["shout"] });
    try {
      expect(toolset.toolNames).toEqual(["demo_add"]);
      expect(await toolset.tools.demo_add.execute({ a: 10, b: 5 }, callOptions)).toBe("15");
    } finally {
      await toolset.close();
    }
  });

  test("the MCP tools mount onto an SDK agent", async () => {
    const toolset = await connectDemo();
    try {
      const agent = new AnthropicAgent({ id: "mcp-agent", model: fakeModel(), tools: toolset.tools });
      expect(agent).toBeDefined();
    } finally {
      await toolset.close();
    }
  });

  test(
    "drains a chatty server's stderr so a >pipe-buffer flood never deadlocks",
    async () => {
      let received = 0;
      const toolset = await createMcpToolset(
        { command: "bun", args: [FLOOD_SERVER] },
        {
          onStderr: (chunk) => {
            received += chunk.length;
          },
        },
      );
      try {
        const flood = 4 * 1024 * 1024;
        const result = await toolset.tools.flood.execute({ bytes: flood }, callOptions);
        expect(result).toContain("flooded");
        // The reply can land before the last stderr chunks are read, so wait for
        // the sink to catch up. Without draining, received stays 0 and this times out.
        await waitUntil(() => received >= flood, 10000);
      } finally {
        await toolset.close();
      }
    },
    20000,
  );

  test("cancels a pending live MCP tool call through the AI SDK abort signal", async () => {
    const toolset = await createMcpToolset({ command: "bun", args: [PENDING_SERVER] });
    const controller = new AbortController();
    try {
      const pending = toolset.tools.wait_forever.execute(
        {},
        { ...callOptions, abortSignal: controller.signal },
      );
      controller.abort(new DOMException("cancelled by caller", "AbortError"));
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      await toolset.close();
    }
  });
});

/**
 * @param {() => boolean} predicate
 * @param {number} timeoutMs
 */
async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A prebuilt language model so constructing the agent needs no API key. */
function fakeModel() {
  return {
    specificationVersion: "v3",
    provider: "test-provider",
    modelId: "fake-model",
    get supportedUrls() {
      return {};
    },
    async doGenerate() {
      return {
        content: [{ type: "text", text: "ok" }],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      };
    },
    async doStream() {
      throw new Error("stream not implemented in test");
    },
  };
}
