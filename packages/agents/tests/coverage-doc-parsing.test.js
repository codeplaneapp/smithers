import { describe, expect, test } from "bun:test";
import { createDocumentParsingToolset } from "../src/document-parsing/createDocumentParsingToolset.js";

const callOptions = { toolCallId: "test-call", messages: [] };
const b64 = (s) => Buffer.from(s).toString("base64");

function parse(options, input) {
  return createDocumentParsingToolset(options).tools.parse_document.execute(input, callOptions);
}

describe("createDocumentParsingToolset provider + input guards", () => {
  test("throws for an unsupported provider string", () => {
    expect(() => createDocumentParsingToolset({ provider: /** @type {any} */ ("nope") })).toThrow(
      /Unsupported document parsing provider/,
    );
  });
  test("rejects input with no source object", async () => {
    await expect(parse({ provider: { name: "x", parseDocument: async () => ({}) } }, {})).rejects.toThrow(
      /requires a source/,
    );
  });

  test("rejects recognized source variants missing required fields before provider requests", async () => {
    let fetchCalls = 0;
    const failIfCalled = async () => {
      fetchCalls += 1;
      throw new Error("fetch should not be called for invalid parse_document input");
    };
    const execute = createDocumentParsingToolset({
      provider: "firecrawl",
      apiKey: "k",
      fetch: failIfCalled,
    }).tools.parse_document.execute;

    await expect(execute({ source: { type: "base64" } }, callOptions)).rejects.toThrow(/parse_document.*source\.data/);
    await expect(execute({ source: { type: "url" } }, callOptions)).rejects.toThrow(/parse_document.*source\.url/);
    await expect(execute({ source: { type: "text" } }, callOptions)).rejects.toThrow(/parse_document.*source\.text/);
    expect(fetchCalls).toBe(0);
  });
});

describe("Mistral OCR provider", () => {
  test("returns text sources verbatim without a network call", async () => {
    let called = 0;
    const result = await parse(
      { provider: "mistral-ocr", apiKey: "k", fetch: async () => { called += 1; return Response.json({}); } },
      { source: { type: "text", text: "inline text" } },
    );
    expect(result).toMatchObject({ provider: "mistral-ocr", text: "inline text" });
    expect(called).toBe(0);
  });

  test("parses a document url and normalizes pages", async () => {
    const result = await parse(
      {
        provider: "mistral-ocr",
        apiKey: "k",
        fetch: async () =>
          Response.json({
            pages: [
              { index: 0, markdown: "# Page", text: "p", images: [{ id: 1 }] },
              { page: 2, text: "second" },
              "not-a-page",
            ],
          }),
      },
      { source: { type: "url", url: "https://example.com/doc.pdf" }, instructions: "extract" },
    );
    expect(result.provider).toBe("mistral-ocr");
    expect(result.markdown).toContain("# Page");
    expect(result.pages).toHaveLength(2);
  });

  test("wraps a base64 pdf and an image as data documents", async () => {
    /** @type {any[]} */
    const bodies = [];
    const opts = {
      provider: "mistral-ocr",
      apiKey: "k",
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init.body)));
        return Response.json({ pages: [{ index: 0, markdown: "m" }] });
      },
    };
    await parse(opts, { source: { type: "base64", data: b64("pdf"), mimeType: "application/pdf" } });
    await parse(opts, { source: { type: "base64", data: b64("img"), mimeType: "image/png" } });
    expect(bodies[0].document.type).toBe("document_url");
    expect(bodies[1].document.type).toBe("image_url");
  });
});

describe("Firecrawl + LlamaParse error and shape branches", () => {
  test("postJson surfaces a non-ok provider response", async () => {
    await expect(
      parse(
        { provider: "firecrawl", apiKey: "k", fetch: async () => new Response("boom", { status: 500 }) },
        { source: { type: "url", url: "https://example.com" } },
      ),
    ).rejects.toThrow(/Document parsing provider failed \(500\)/);
  });

  test("postMultipart surfaces a non-ok provider response", async () => {
    await expect(
      parse(
        { provider: "firecrawl", apiKey: "k", fetch: async () => new Response("", { status: 413, statusText: "Too Large" }) },
        { source: { type: "base64", data: b64("x"), mimeType: "application/pdf" } },
      ),
    ).rejects.toThrow(/Document parsing provider failed \(413\)/);
  });

  test("missing api key is rejected before any request", async () => {
    await expect(
      parse(
        { provider: "firecrawl", apiKey: undefined, fetch: async () => Response.json({}) },
        { source: { type: "url", url: "https://example.com" } },
      ),
    ).rejects.toThrow(/Missing API key/);
  });

  test("LlamaParse polls until COMPLETED and honors a text outputFormat", async () => {
    let poll = 0;
    const result = await parse(
      {
        provider: "llamaparse",
        apiKey: "k",
        fetch: async (url) => {
          const u = String(url);
          if (u.endsWith("/api/v2/parse")) return Response.json({ job: { id: "job-1" } });
          poll += 1;
          if (poll < 2) return Response.json({ job: { id: "job-1", status: "PENDING" } });
          return Response.json({ job: { id: "job-1", status: "COMPLETED" }, text_full: "plain text" });
        },
      },
      { source: { type: "url", url: "https://example.com/x.pdf" }, outputFormat: "text", instructions: "go" },
    );
    expect(result).toMatchObject({ provider: "llamaparse", text: "plain text" });
    expect(poll).toBeGreaterThanOrEqual(2);
  }, 15000);

  test("LlamaParse throws when the job fails", async () => {
    await expect(
      parse(
        {
          provider: "llamaparse",
          apiKey: "k",
          fetch: async (url) => {
            const u = String(url);
            if (u.endsWith("/api/v2/parse")) return Response.json({ id: "job-2" });
            return Response.json({ status: "FAILED", error_message: "bad doc" });
          },
        },
        { source: { type: "url", url: "https://example.com/x.pdf" } },
      ),
    ).rejects.toThrow(/job-2 FAILED: bad doc/);
  });

  test("LlamaParse getJson surfaces a non-ok poll response", async () => {
    await expect(
      parse(
        {
          provider: "llamaparse",
          apiKey: "k",
          fetch: async (url) => {
            const u = String(url);
            if (u.endsWith("/api/v2/parse")) return Response.json({ id: "job-3" });
            return new Response("nope", { status: 502 });
          },
        },
        { source: { type: "url", url: "https://example.com/x.pdf" } },
      ),
    ).rejects.toThrow(/Document parsing provider failed \(502\)/);
  });

  test("LlamaParse rejects when the upload returns no file id", async () => {
    await expect(
      parse(
        {
          provider: "llamaparse",
          apiKey: "k",
          fetch: async () => Response.json({}),
        },
        { source: { type: "base64", data: b64("x"), mimeType: "application/pdf" } },
      ),
    ).rejects.toThrow(/did not return an uploaded file id/);
  });

  test("firecrawl base64 filename defaults cover every known mime type", async () => {
    /** @type {string[]} */
    const names = [];
    const opts = {
      provider: "firecrawl",
      apiKey: "k",
      fetch: async (_url, init) => {
        const form = await new Response(init.body, { headers: init.headers }).formData();
        const file = /** @type {File} */ (form.get("file"));
        names.push(file.name);
        return Response.json({ data: { markdown: "ok" } });
      },
    };
    const mimes = [
      "application/pdf",
      "text/html",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/x-unknown",
    ];
    for (const mimeType of mimes) {
      await parse(opts, { source: { type: "base64", data: b64("x"), mimeType } });
    }
    expect(names).toEqual([
      "document.pdf",
      "document.html",
      "document.docx",
      "document.xlsx",
      "document.bin",
    ]);
  });

  test("sourceToBlob rejects a source type it cannot upload", async () => {
    await expect(
      parse(
        { provider: "firecrawl", apiKey: "k", fetch: async () => Response.json({ data: {} }) },
        { source: /** @type {any} */ ({ type: "weird", data: "x" }) },
      ),
    ).rejects.toThrow(/File upload requires base64 or text source/);
  });

  test("LlamaParse throws after exhausting its poll budget", async () => {
    await expect(
      parse(
        {
          provider: "llamaparse",
          apiKey: "k",
          fetch: async (url) => {
            const u = String(url);
            if (u.endsWith("/api/v2/parse")) return Response.json({ id: "job-slow" });
            return Response.json({ status: "PENDING" });
          },
        },
        { source: { type: "url", url: "https://example.com/x.pdf" } },
      ),
    ).rejects.toThrow(/did not complete before timeout/);
  }, 45000);

  test("error responses whose body cannot be read still throw cleanly", async () => {
    const rejectingText = (status) => ({
      ok: false,
      status,
      statusText: `Status ${status}`,
      text: async () => {
        throw new Error("body gone");
      },
    });
    // postJson (firecrawl /scrape)
    await expect(
      parse(
        { provider: "firecrawl", apiKey: "k", fetch: async () => rejectingText(500) },
        { source: { type: "url", url: "https://example.com" } },
      ),
    ).rejects.toThrow(/failed \(500\): Status 500/);
    // postMultipart (firecrawl /parse)
    await expect(
      parse(
        { provider: "firecrawl", apiKey: "k", fetch: async () => rejectingText(502) },
        { source: { type: "base64", data: b64("x"), mimeType: "application/pdf" } },
      ),
    ).rejects.toThrow(/failed \(502\): Status 502/);
    // getJson (llamaparse poll)
    await expect(
      parse(
        {
          provider: "llamaparse",
          apiKey: "k",
          fetch: async (url) =>
            String(url).endsWith("/api/v2/parse") ? Response.json({ id: "job-x" }) : rejectingText(503),
        },
        { source: { type: "url", url: "https://example.com/x.pdf" } },
      ),
    ).rejects.toThrow(/failed \(503\): Status 503/);
  });

  test("firecrawl accepts a text source upload", async () => {
    let name;
    await parse(
      {
        provider: "firecrawl",
        apiKey: "k",
        fetch: async (_url, init) => {
          const form = await new Response(init.body, { headers: init.headers }).formData();
          name = /** @type {File} */ (form.get("file")).name;
          return Response.json({ data: { markdown: "ok" } });
        },
      },
      { source: { type: "text", text: "<p>hi</p>" }, outputFormat: "json" },
    );
    expect(name).toBe("document.html");
  });
});
