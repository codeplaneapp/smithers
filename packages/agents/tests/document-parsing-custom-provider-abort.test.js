import { describe, expect, test } from "bun:test";
import { createDocumentParsingToolset } from "../src/document-parsing/createDocumentParsingToolset.js";

/** AI SDK passes these to `execute`; abort tests extend them with an abortSignal. */
const callOptions = { toolCallId: "test-call", messages: [] };

describe("custom provider abort propagation", () => {
  test("threads the exact AI SDK abortSignal and normalized input into an injected provider", async () => {
    const controller = new AbortController();
    /** @type {AbortSignal | undefined} */
    let capturedSignal;
    /** @type {any} */
    let capturedInput;
    const toolset = createDocumentParsingToolset({
      provider: {
        name: "custom-capture",
        parseDocument: async (input, options) => {
          capturedInput = input;
          capturedSignal = options?.abortSignal;
          return { provider: "custom-capture", text: `parsed ${input.source.type}`, metadata: { title: "Fixture" } };
        },
      },
    });
    await expect(
      toolset.tools.parse_document.execute(
        {
          source: { type: "url", url: "https://example.com/report.pdf" },
          outputFormat: "markdown",
          instructions: "tables",
        },
        { ...callOptions, abortSignal: controller.signal },
      ),
    ).resolves.toEqual({ provider: "custom-capture", text: "parsed url", metadata: { title: "Fixture" } });
    expect(capturedSignal).toBe(controller.signal);
    expect(capturedInput).toEqual({
      source: { type: "url", url: "https://example.com/report.pdf" },
      outputFormat: "markdown",
      instructions: "tables",
    });
  });

  test("aborting cancels a custom provider's pending request against a real server and rejects promptly", async () => {
    /** @type {() => void} */
    let requestArrived = () => {};
    const arrived = new Promise((resolve) => {
      requestArrived = /** @type {() => void} */ (resolve);
    });
    const server = Bun.serve({
      port: 0,
      fetch: async () => {
        requestArrived();
        await new Promise(() => {});
        return new Response("unreachable");
      },
    });
    try {
      const toolset = createDocumentParsingToolset({
        provider: {
          name: "custom-remote",
          parseDocument: async (input, options) => {
            const response = await fetch(`http://127.0.0.1:${server.port}/parse`, {
              method: "POST",
              body: JSON.stringify(input),
              signal: options?.abortSignal,
            });
            return { provider: "custom-remote", text: await response.text() };
          },
        },
      });
      const controller = new AbortController();
      const execution = toolset.tools.parse_document.execute(
        { source: { type: "url", url: "https://example.com/doc.pdf" } },
        { ...callOptions, abortSignal: controller.signal },
      );
      await arrived;
      const abortedAt = Date.now();
      controller.abort();
      await expect(execution).rejects.toThrow(/abort/i);
      expect(Date.now() - abortedAt).toBeLessThan(2000);
    } finally {
      server.stop(true);
    }
  });

  test("invalid input still fails normalization before the custom provider runs", async () => {
    let providerCalls = 0;
    const toolset = createDocumentParsingToolset({
      provider: {
        name: "custom-guarded",
        parseDocument: async () => {
          providerCalls += 1;
          return { provider: "custom-guarded", text: "unreachable" };
        },
      },
    });
    await expect(
      toolset.tools.parse_document.execute(
        { source: { type: "url" } },
        { ...callOptions, abortSignal: new AbortController().signal },
      ),
    ).rejects.toThrow(/parse_document.*source\.url/);
    expect(providerCalls).toBe(0);
  });

  test("custom providers still resolve when the AI SDK passes no abortSignal", async () => {
    /** @type {{ abortSignal?: AbortSignal } | undefined} */
    let capturedOptions;
    const toolset = createDocumentParsingToolset({
      provider: {
        name: "custom-optional",
        parseDocument: async (input, options) => {
          capturedOptions = options;
          return { provider: "custom-optional", text: input.source.type === "text" ? input.source.text : "" };
        },
      },
    });
    await expect(
      toolset.tools.parse_document.execute({ source: { type: "text", text: "inline text" } }, callOptions),
    ).resolves.toMatchObject({ provider: "custom-optional", text: "inline text" });
    expect(capturedOptions?.abortSignal).toBeUndefined();
  });
});
