import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { createMcpToolset } from "../src/mcp/createMcpToolset.js";

const SLOW_SERVER = resolve(import.meta.dir, "fixtures", "slow-mcp-server.js");

/** AI SDK-shaped call options; `abortSignal` is what the toolset must forward. */
const baseCallOptions = { toolCallId: "test-call", messages: [] };

describe("createMcpToolset cancellation (real MCP server over stdio)", () => {
  test(
    "aborting the AI SDK call rejects promptly and cancels the MCP request server-side",
    async () => {
      let stderrText = "";
      const toolset = await createMcpToolset(
        { command: "bun", args: [SLOW_SERVER] },
        {
          onStderr: (chunk) => {
            stderrText += chunk;
          },
        },
      );
      try {
        const controller = new AbortController();
        const started = Date.now();
        const pending = toolset.tools.sleep.execute(
          // Longer than the SDK's 60s default request timeout: without signal
          // forwarding this call would hang until that timeout, not reject.
          { ms: 120000 },
          { ...baseCallOptions, abortSignal: controller.signal },
        );
        setTimeout(() => controller.abort(), 100);
        const error = await pending.then(
          () => null,
          (cause) => cause,
        );
        // The call rejected with the abort, promptly — not after the sleep or
        // the 60s MCP request timeout.
        expect(error).not.toBeNull();
        expect(String(error)).toMatch(/abort/i);
        expect(Date.now() - started).toBeLessThan(10000);
        // The server observed `notifications/cancelled`: its handler's signal
        // aborted and it reported so on stderr. Without forwarding, the sleep
        // keeps running server-side and this times out.
        await waitUntil(() => stderrText.includes("sleep-cancelled"), 5000);
      } finally {
        await toolset.close();
      }
    },
    20000,
  );

  test("a call carrying an un-aborted signal still completes normally", async () => {
    const toolset = await createMcpToolset({ command: "bun", args: [SLOW_SERVER] });
    try {
      const controller = new AbortController();
      const result = await toolset.tools.sleep.execute(
        { ms: 10 },
        { ...baseCallOptions, abortSignal: controller.signal },
      );
      expect(result).toBe("slept");
    } finally {
      await toolset.close();
    }
  });

  test("an already-aborted signal rejects without running the tool", async () => {
    let stderrText = "";
    const toolset = await createMcpToolset(
      { command: "bun", args: [SLOW_SERVER] },
      {
        onStderr: (chunk) => {
          stderrText += chunk;
        },
      },
    );
    try {
      const controller = new AbortController();
      controller.abort();
      const error = await toolset.tools.sleep
        .execute({ ms: 120000 }, { ...baseCallOptions, abortSignal: controller.signal })
        .then(
          () => null,
          (cause) => cause,
        );
      expect(error).not.toBeNull();
      expect(String(error)).toMatch(/abort/i);
      expect(stderrText).not.toContain("sleep-cancelled");
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
    await new Promise((resolveTick) => setTimeout(resolveTick, 10));
  }
}
