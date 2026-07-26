import { describe, expect, test } from "bun:test";
import { createDocumentParsingToolset } from "../src/document-parsing/createDocumentParsingToolset.js";

/** AI SDK passes these to `execute`; abort tests extend them with an abortSignal. */
const callOptions = { toolCallId: "test-call", messages: [] };

describe("Firecrawl abort propagation", () => {
  test("aborting cancels a never-settling scrape against a real server and rejects promptly", async () => {
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
        provider: "firecrawl",
        apiKey: "fc-test",
        baseUrl: `http://127.0.0.1:${server.port}/v2`,
      });
      const controller = new AbortController();
      const execution = toolset.tools.parse_document.execute(
        { source: { type: "url", url: "https://example.com/report.pdf" } },
        { ...callOptions, abortSignal: controller.signal },
      );
      const body = await arrived;
      expect(body).toMatchObject({ url: "https://example.com/report.pdf" });
      const abortedAt = Date.now();
      controller.abort();
      await expect(execution).rejects.toThrow(/abort/i);
      expect(Date.now() - abortedAt).toBeLessThan(2000);
    } finally {
      server.stop(true);
    }
  });

  test("threads the exact AI SDK abortSignal into the multipart parse fetch init", async () => {
    const controller = new AbortController();
    /** @type {AbortSignal | null | undefined} */
    let capturedSignal;
    const toolset = createDocumentParsingToolset({
      provider: "firecrawl",
      apiKey: "fc-test",
      fetch: async (url, init) => {
        expect(String(url)).toBe("https://api.firecrawl.dev/v2/parse");
        capturedSignal = init?.signal;
        return Response.json({ data: { markdown: "# Parsed PDF" } });
      },
    });
    await expect(
      toolset.tools.parse_document.execute(
        { source: { type: "base64", data: Buffer.from("pdf bytes").toString("base64"), mimeType: "application/pdf" } },
        { ...callOptions, abortSignal: controller.signal },
      ),
    ).resolves.toMatchObject({ provider: "firecrawl", markdown: "# Parsed PDF" });
    expect(capturedSignal).toBe(controller.signal);
  });
});

describe("LlamaParse abort propagation", () => {
  test("aborting cancels a never-settling parse job creation against a real server and rejects promptly", async () => {
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
        provider: "llamaparse",
        apiKey: "llx-test",
        baseUrl: `http://127.0.0.1:${server.port}`,
      });
      const controller = new AbortController();
      const execution = toolset.tools.parse_document.execute(
        { source: { type: "url", url: "https://example.com/report.pdf" } },
        { ...callOptions, abortSignal: controller.signal },
      );
      const body = await arrived;
      expect(body).toMatchObject({ source_url: "https://example.com/report.pdf", tier: "agentic" });
      const abortedAt = Date.now();
      controller.abort();
      await expect(execution).rejects.toThrow(/abort/i);
      expect(Date.now() - abortedAt).toBeLessThan(2000);
    } finally {
      server.stop(true);
    }
  });

  test("threads the exact AI SDK abortSignal through upload, job creation, and polling fetches", async () => {
    const controller = new AbortController();
    /** @type {(AbortSignal | null | undefined)[]} */
    const capturedSignals = [];
    const toolset = createDocumentParsingToolset({
      provider: "llamaparse",
      apiKey: "llx-test",
      fetch: async (url, init) => {
        capturedSignals.push(init?.signal);
        if (String(url).endsWith("/api/v1/files/")) return Response.json({ id: "file-123" });
        if (String(url).endsWith("/api/v2/parse")) return Response.json({ id: "job-123" });
        return Response.json({
          job: { id: "job-123", status: "COMPLETED" },
          markdown_full: "# Parsed",
          text_full: "Parsed",
        });
      },
    });
    await expect(
      toolset.tools.parse_document.execute(
        { source: { type: "base64", data: Buffer.from("pdf bytes").toString("base64"), mimeType: "application/pdf" } },
        { ...callOptions, abortSignal: controller.signal },
      ),
    ).resolves.toMatchObject({ provider: "llamaparse", markdown: "# Parsed", text: "Parsed" });
    expect(capturedSignals).toHaveLength(3);
    for (const signal of capturedSignals) expect(signal).toBe(controller.signal);
  });

  test("aborting during the polling delay rejects promptly against a real server", async () => {
    /** @type {number[]} */
    const polls = [];
    /** @type {() => void} */
    let firstPollArrived = () => {};
    const firstPoll = new Promise((resolve) => {
      firstPollArrived = resolve;
    });
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/api/v2/parse") return Response.json({ id: "job-abort" });
        polls.push(Date.now());
        firstPollArrived();
        return Response.json({ job: { id: "job-abort", status: "PENDING" } });
      },
    });
    try {
      const toolset = createDocumentParsingToolset({
        provider: "llamaparse",
        apiKey: "llx-test",
        baseUrl: `http://127.0.0.1:${server.port}`,
      });
      const controller = new AbortController();
      const execution = toolset.tools.parse_document.execute(
        { source: { type: "url", url: "https://example.com/report.pdf" } },
        { ...callOptions, abortSignal: controller.signal },
      );
      await firstPoll;
      // Let the client consume the PENDING response and enter the 1s poll delay.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const abortedAt = Date.now();
      controller.abort();
      await expect(execution).rejects.toThrow(/abort/i);
      // Rejection must interrupt the delay, not wait out the 1s poll interval.
      expect(Date.now() - abortedAt).toBeLessThan(500);
      expect(polls).toHaveLength(1);
    } finally {
      server.stop(true);
    }
  });

  test("an already-aborted signal stops polling without another status fetch, even when fetch ignores the signal", async () => {
    const controller = new AbortController();
    let pollCount = 0;
    const toolset = createDocumentParsingToolset({
      provider: "llamaparse",
      apiKey: "llx-test",
      // Deliberately ignores init.signal so the abortable delay is the only cancellation point.
      fetch: async (url) => {
        if (String(url).endsWith("/api/v2/parse")) return Response.json({ id: "job-1" });
        pollCount += 1;
        controller.abort();
        return Response.json({ job: { id: "job-1", status: "PENDING" } });
      },
    });
    const startedAt = Date.now();
    await expect(
      toolset.tools.parse_document.execute(
        { source: { type: "url", url: "https://example.com/report.pdf" } },
        { ...callOptions, abortSignal: controller.signal },
      ),
    ).rejects.toThrow(/abort/i);
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(pollCount).toBe(1);
  });
});
