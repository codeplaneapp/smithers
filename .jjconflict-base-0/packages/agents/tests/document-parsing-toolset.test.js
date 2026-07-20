import { describe, expect, test } from "bun:test";
import { AnthropicAgent } from "../src/index.js";
import { createDocumentParsingToolset } from "../src/document-parsing/createDocumentParsingToolset.js";

/** AI SDK passes these to `execute`; the parser tool ignores them. */
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
    expect(captured?.headers).toMatchObject({ Authorization: "Bearer fc-test" });
  });

  test("uses Firecrawl document parsing for base64 file input", async () => {
    /** @type {FormData | undefined} */
    let capturedBody;
    const toolset = createDocumentParsingToolset({
      provider: "firecrawl",
      apiKey: "fc-test",
      fetch: async (url, init) => {
        expect(String(url)).toBe("https://api.firecrawl.dev/v2/parse");
        capturedBody = /** @type {FormData} */ (init?.body);
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
    expect(capturedBody).toBeInstanceOf(FormData);
    expect(capturedBody?.get("file")).toBeInstanceOf(Blob);
    expect(capturedBody?.get("options")).toBe(JSON.stringify({ formats: ["markdown"], parsers: [{ type: "pdf", mode: "auto" }] }));
  });

  test("uploads base64 file input before starting a LlamaParse job", async () => {
    const calls = [];
    const toolset = createDocumentParsingToolset({
      provider: "llamaparse",
      apiKey: "llx-test",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        if (String(url).endsWith("/api/v1/files/")) {
          expect(init?.body).toBeInstanceOf(FormData);
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
