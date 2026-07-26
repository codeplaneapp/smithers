import { describe, expect, test } from "bun:test";
import { createDocumentParsingToolset } from "../src/document-parsing/createDocumentParsingToolset.js";

/** AI SDK passes these to `execute`; abort tests extend them with an abortSignal. */
const callOptions = { toolCallId: "test-call", messages: [] };

describe("Mistral OCR abort propagation", () => {
  test("aborting cancels a pending OCR request against a real server and rejects promptly", async () => {
    /** @type {(body: unknown) => void} */
    let requestArrived = () => {};
    const arrived = new Promise((resolve) => {
      requestArrived = resolve;
    });
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        requestArrived(await request.json());
        await new Promise(() => {});
        return new Response("unreachable");
      },
    });
    try {
      const toolset = createDocumentParsingToolset({
        provider: "mistral-ocr",
        apiKey: "test-key",
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
      });
      const controller = new AbortController();
      const execution = toolset.tools.parse_document.execute(
        { source: { type: "url", url: "https://example.com/doc.pdf" }, instructions: "extract tables" },
        { ...callOptions, abortSignal: controller.signal },
      );
      const body = await arrived;
      expect(body).toMatchObject({
        model: "mistral-ocr-latest",
        document: { type: "document_url", document_url: "https://example.com/doc.pdf" },
        prompt: "extract tables",
      });
      const abortedAt = Date.now();
      controller.abort();
      await expect(execution).rejects.toThrow(/abort/i);
      expect(Date.now() - abortedAt).toBeLessThan(2000);
    } finally {
      server.stop(true);
    }
  });

  test("threads the exact AI SDK abortSignal into the OCR fetch init for base64 images", async () => {
    const controller = new AbortController();
    /** @type {AbortSignal | null | undefined} */
    let capturedSignal;
    /** @type {any} */
    let capturedBody;
    const toolset = createDocumentParsingToolset({
      provider: "mistral-ocr",
      apiKey: "test-key",
      fetch: async (_url, init) => {
        capturedSignal = init?.signal;
        capturedBody = JSON.parse(String(init?.body));
        return Response.json({ pages: [{ index: 0, markdown: "# Page" }] });
      },
    });
    await expect(
      toolset.tools.parse_document.execute(
        { source: { type: "base64", data: Buffer.from("img").toString("base64"), mimeType: "image/png" } },
        { ...callOptions, abortSignal: controller.signal },
      ),
    ).resolves.toMatchObject({
      provider: "mistral-ocr",
      markdown: "# Page",
      pages: [{ index: 0, markdown: "# Page" }],
    });
    expect(capturedSignal).toBe(controller.signal);
    expect(capturedBody.document.type).toBe("image_url");
  });

  test("text sources still resolve locally even when the signal is already aborted", async () => {
    let fetchCalls = 0;
    const toolset = createDocumentParsingToolset({
      provider: "mistral-ocr",
      apiKey: "test-key",
      fetch: async () => {
        fetchCalls += 1;
        return Response.json({});
      },
    });
    await expect(
      toolset.tools.parse_document.execute(
        { source: { type: "text", text: "inline text" } },
        { ...callOptions, abortSignal: AbortSignal.abort() },
      ),
    ).resolves.toMatchObject({ provider: "mistral-ocr", text: "inline text" });
    expect(fetchCalls).toBe(0);
  });
});
