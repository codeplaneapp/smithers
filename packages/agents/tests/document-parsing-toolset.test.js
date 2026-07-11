import { describe, expect, test } from "bun:test";
import { AnthropicAgent } from "../src/index.js";
import { createDocumentParsingToolset } from "../src/document-parsing/createDocumentParsingToolset.js";

const callOptions = { toolCallId: "test-call", messages: [] };

describe("createDocumentParsingToolset", () => {
  test("exposes a parse_document AI SDK tool backed by a provider", async () => {
    const toolset = createDocumentParsingToolset({
      provider: {
        name: "test-provider",
        parseDocument: async (input) => ({
          provider: "test-provider",
          text: `parsed ${input.source.type}:${input.source.url}`,
          markdown: "# Parsed",
          pages: [{ index: 1, text: "page one" }],
          metadata: { title: "Fixture" },
        }),
      },
    });

    expect(toolset.toolNames).toEqual(["parse_document"]);
    expect(typeof toolset.tools.parse_document.execute).toBe("function");

    await expect(
      toolset.tools.parse_document.execute(
        { source: { type: "url", url: "https://example.com/report.pdf" }, outputFormat: "markdown" },
        callOptions,
      ),
    ).resolves.toEqual({
      provider: "test-provider",
      text: "parsed url:https://example.com/report.pdf",
      markdown: "# Parsed",
      pages: [{ index: 1, text: "page one" }],
      metadata: { title: "Fixture" },
    });
  });

  test("defaults to the firecrawl provider and forwards credentials", async () => {
    /** @type {RequestInit | undefined} */
    let captured;
    /** @type {string | undefined} */
    let capturedUrl;
    const toolset = createDocumentParsingToolset({
      provider: "firecrawl",
      apiKey: "fc-test",
      fetch: async (url, init) => {
        capturedUrl = String(url);
        captured = init;
        return new Response(JSON.stringify({ data: { markdown: "## Doc", metadata: { sourceURL: "https://example.com" } } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    await expect(
      toolset.tools.parse_document.execute({ source: { type: "url", url: "https://example.com" } }, callOptions),
    ).resolves.toMatchObject({
      provider: "firecrawl",
      markdown: "## Doc",
      text: "## Doc",
      metadata: { sourceURL: "https://example.com" },
    });
    expect(capturedUrl).toBe("https://api.firecrawl.dev/v2/scrape");
    expect(new Headers(captured?.headers).get("authorization")).toBe("Bearer fc-test");
  });

  test("blocks a document provider redirect into a private destination", async () => {
    let calls = 0;
    const toolset = createDocumentParsingToolset({
      provider: "firecrawl",
      apiKey: "fc-test",
      fetch: async () => {
        calls += 1;
        return new Response(null, {
          status: 302,
          headers: { location: "https://10.0.0.1/private" },
        });
      },
    });

    await expect(toolset.tools.parse_document.execute(
      { source: { type: "url", url: "https://example.com/report.pdf" } },
      callOptions,
    )).rejects.toMatchObject({
      code: "INVALID_URL",
      details: { reason: "non-public-destination" },
    });
    expect(calls).toBe(1);
  });

  test("uses Firecrawl document parsing for base64 file input", async () => {
    /** @type {FormData | undefined} */
    let capturedForm;
    const toolset = createDocumentParsingToolset({
      provider: "firecrawl",
      apiKey: "fc-test",
      fetch: async (url, init) => {
        expect(String(url)).toBe("https://api.firecrawl.dev/v2/parse");
        capturedForm = await new Response(init?.body, { headers: init?.headers }).formData();
        return new Response(JSON.stringify({ success: true, data: { markdown: "# Parsed PDF" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    await expect(
      toolset.tools.parse_document.execute(
        {
          source: { type: "base64", data: Buffer.from("pdf bytes").toString("base64"), mimeType: "application/pdf", filename: "report.pdf" },
          outputFormat: "markdown",
        },
        callOptions,
      ),
    ).resolves.toMatchObject({ provider: "firecrawl", markdown: "# Parsed PDF", text: "# Parsed PDF" });
    expect(capturedForm).toBeInstanceOf(FormData);
    expect(capturedForm?.get("file")).toBeInstanceOf(Blob);
    expect(capturedForm?.get("options")).toBe(JSON.stringify({ formats: ["markdown"], parsers: [{ type: "pdf", mode: "auto" }] }));
  });

  test("uploads base64 file input before starting a LlamaParse job", async () => {
    const calls = [];
    const toolset = createDocumentParsingToolset({
      provider: "llamaparse",
      apiKey: "llx-test",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        if (String(url).endsWith("/api/v1/files/")) {
          const form = await new Response(init?.body, { headers: init?.headers }).formData();
          expect(form.get("file")).toBeInstanceOf(Blob);
          return Response.json({ id: "file-123" });
        }
        if (String(url).endsWith("/api/v2/parse")) {
          expect(JSON.parse(String(init?.body))).toMatchObject({ file_id: "file-123", tier: "agentic", version: "latest" });
          return Response.json({ id: "job-123", status: "PENDING" });
        }
        expect(String(url)).toContain("/api/v2/parse/job-123?expand=markdown_full,text_full,metadata");
        return Response.json({ job: { id: "job-123", status: "COMPLETED" }, markdown_full: "# Parsed", text_full: "Parsed" });
      },
    });

    await expect(
      toolset.tools.parse_document.execute(
        { source: { type: "base64", data: Buffer.from("pdf bytes").toString("base64"), mimeType: "application/pdf" } },
        callOptions,
      ),
    ).resolves.toMatchObject({ provider: "llamaparse", markdown: "# Parsed", text: "Parsed" });
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.cloud.llamaindex.ai/api/v1/files/",
      "https://api.cloud.llamaindex.ai/api/v2/parse",
      "https://api.cloud.llamaindex.ai/api/v2/parse/job-123?expand=markdown_full,text_full,metadata",
    ]);
  });

  test("the document parser tools mount onto an SDK agent", () => {
    const toolset = createDocumentParsingToolset({
      provider: { name: "test-provider", parseDocument: async () => ({ provider: "test-provider", text: "ok" }) },
    });
    const agent = new AnthropicAgent({ id: "document-parser-agent", model: fakeModel(), tools: toolset.tools });
    expect(agent).toBeDefined();
  });

  test("passes the AI SDK abort signal to a custom provider", async () => {
    const controller = new AbortController();
    let observed;
    const toolset = createDocumentParsingToolset({
      provider: {
        name: "custom",
        parseDocument: async (_input, options) => {
          observed = options?.signal;
          return { provider: "custom", text: "ok" };
        },
      },
    });
    await toolset.tools.parse_document.execute(
      { source: { type: "text", text: "hello" } },
      { ...callOptions, abortSignal: controller.signal },
    );
    expect(observed).toBe(controller.signal);
  });

  test("rejects oversized base64 and UTF-8 text before provider execution", async () => {
    let calls = 0;
    const toolset = createDocumentParsingToolset({
      maxInputBytes: 4,
      provider: {
        name: "custom",
        parseDocument: async () => {
          calls += 1;
          return { provider: "custom", text: "unexpected" };
        },
      },
    });

    await expect(
      toolset.tools.parse_document.execute(
        { source: { type: "base64", data: Buffer.from("12345").toString("base64") } },
        callOptions,
      ),
    ).rejects.toThrow(/4 bytes/);
    await expect(
      toolset.tools.parse_document.execute(
        { source: { type: "text", text: "🙂a" } },
        callOptions,
      ),
    ).rejects.toThrow(/4 bytes/);
    expect(calls).toBe(0);
  });

  test("accepts base64 and UTF-8 text exactly at the input cap", async () => {
    const seen = [];
    const toolset = createDocumentParsingToolset({
      maxInputBytes: 4,
      provider: {
        name: "custom",
        parseDocument: async (input) => {
          seen.push(input.source.type);
          return { provider: "custom", text: "ok" };
        },
      },
    });

    await expect(
      toolset.tools.parse_document.execute(
        { source: { type: "base64", data: Buffer.from("1234").toString("base64") } },
        callOptions,
      ),
    ).resolves.toMatchObject({ text: "ok" });
    await expect(
      toolset.tools.parse_document.execute(
        { source: { type: "text", text: "🙂" } },
        callOptions,
      ),
    ).resolves.toMatchObject({ text: "ok" });
    expect(seen).toEqual(["base64", "text"]);
  });

  test("rejects malformed base64 and invalid input limits before provider execution", async () => {
    expect(() => createDocumentParsingToolset({
      maxInputBytes: -1,
      provider: { name: "custom", parseDocument: async () => ({ text: "unused" }) },
    })).toThrow(/non-negative safe integer/);

    let called = false;
    const toolset = createDocumentParsingToolset({
      provider: {
        name: "custom",
        parseDocument: async () => {
          called = true;
          return { provider: "custom", text: "unexpected" };
        },
      },
    });
    await expect(
      toolset.tools.parse_document.execute(
        { source: { type: "base64", data: "YQ=" } },
        callOptions,
      ),
    ).rejects.toThrow(/Invalid base64 input/);
    expect(called).toBe(false);
  });

  test("bounds provider response bodies", async () => {
    const toolset = createDocumentParsingToolset({
      provider: "firecrawl",
      apiKey: "key",
      maxResponseBytes: 4,
      fetch: async () => new Response("12345", { headers: { "content-length": "5" } }),
    });
    await expect(
      toolset.tools.parse_document.execute(
        { source: { type: "url", url: "https://example.com/doc" } },
        callOptions,
      ),
    ).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
  });

  test("redacts a reflected provider API key from non-2xx errors", async () => {
    const toolset = createDocumentParsingToolset({
      provider: "firecrawl",
      apiKey: "document-secret",
      fetch: async () => new Response("received bearer document-secret", { status: 500 }),
    });
    let caught;
    try {
      await toolset.tools.parse_document.execute(
        { source: { type: "url", url: "https://example.com/doc" } },
        callOptions,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught?.message).toContain("[REDACTED]");
    expect(caught?.message).not.toContain("document-secret");
  });

  test("rejects non-HTTP document source URLs before provider execution", async () => {
    let called = 0;
    const toolset = createDocumentParsingToolset({
      provider: {
        name: "custom",
        parseDocument: async () => {
          called += 1;
          return { provider: "custom", text: "unsafe" };
        },
      },
    });
    await expect(
      toolset.tools.parse_document.execute(
        { source: { type: "url", url: "file:///etc/passwd" } },
        callOptions,
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_PROTOCOL" });
    expect(called).toBe(0);
  });

  test("cancels a pending provider request", async () => {
    const controller = new AbortController();
    const toolset = createDocumentParsingToolset({
      provider: "mistral-ocr",
      apiKey: "key",
      fetch: async (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    });
    const pending = toolset.tools.parse_document.execute(
      { source: { type: "url", url: "https://example.com/doc.pdf" } },
      { ...callOptions, abortSignal: controller.signal },
    );
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  test("preserves cancellation while reading a non-2xx provider body", async () => {
    const controller = new AbortController();
    const reason = new DOMException("cancelled during provider error", "AbortError");
    const toolset = createDocumentParsingToolset({
      provider: "firecrawl",
      apiKey: "key",
      fetch: async () => {
        queueMicrotask(() => controller.abort(reason));
        return new Response("provider failure", { status: 500 });
      },
    });

    let caught;
    try {
      await toolset.tools.parse_document.execute(
        { source: { type: "url", url: "https://example.com/doc.pdf" } },
        { ...callOptions, abortSignal: controller.signal },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(reason);
  });

  test("cancels LlamaParse while waiting between status polls", async () => {
    const controller = new AbortController();
    let polls = 0;
    const toolset = createDocumentParsingToolset({
      provider: "llamaparse",
      apiKey: "key",
      fetch: async (url) => {
        if (String(url).endsWith("/api/v2/parse")) {
          return Response.json({ id: "job-pending" });
        }
        polls += 1;
        return Response.json({ job: { id: "job-pending", status: "PENDING" } });
      },
    });
    const pending = toolset.tools.parse_document.execute(
      { source: { type: "url", url: "https://example.com/doc.pdf" } },
      { ...callOptions, abortSignal: controller.signal },
    );
    while (polls === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

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
