import { describe, expect, test } from "bun:test";
import { createDocumentParsingToolset } from "../src/document-parsing/createDocumentParsingToolset.js";

/** AI SDK passes these to `execute`; abort tests extend them with an abortSignal. */
const callOptions = { toolCallId: "test-call", messages: [] };

describe("LlamaParse abort propagation", () => {
  test("aborting cancels a pending upload request against a real server and rejects promptly", async () => {
    /** @type {() => void} */
    let uploadArrived = () => {};
    const arrived = new Promise((resolve) => {
      uploadArrived = () => resolve(undefined);
    });
    /** @type {string[]} */
    const paths = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        paths.push(new URL(request.url).pathname);
        uploadArrived();
        await new Promise(() => {});
        return new Response("unreachable");
      },
    });
    try {
      const toolset = createDocumentParsingToolset({
        provider: "llamaparse",
        apiKey: "test-key",
        baseUrl: `http://127.0.0.1:${server.port}`,
      });
      const controller = new AbortController();
      const execution = toolset.tools.parse_document.execute(
        { source: { type: "base64", data: Buffer.from("pdf bytes").toString("base64"), mimeType: "application/pdf" } },
        { ...callOptions, abortSignal: controller.signal },
      );
      await arrived;
      const abortedAt = Date.now();
      controller.abort();
      await expect(execution).rejects.toThrow(/abort/i);
      expect(Date.now() - abortedAt).toBeLessThan(2000);
      // Only the upload was attempted; the job was never created after the abort.
      expect(paths).toEqual(["/api/v1/files/"]);
    } finally {
      server.stop(true);
    }
  });

  test("aborting during the polling interval rejects promptly instead of sleeping out the delay", async () => {
    /** @type {() => void} */
    let statusPolled = () => {};
    const firstPoll = new Promise((resolve) => {
      statusPolled = () => resolve(undefined);
    });
    let statusCalls = 0;
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/api/v2/parse") return Response.json({ id: "job-1", status: "PENDING" });
        statusCalls += 1;
        statusPolled();
        return Response.json({ job: { id: "job-1", status: "PENDING" } });
      },
    });
    try {
      const toolset = createDocumentParsingToolset({
        provider: "llamaparse",
        apiKey: "test-key",
        baseUrl: `http://127.0.0.1:${server.port}`,
      });
      const controller = new AbortController();
      const execution = toolset.tools.parse_document.execute(
        { source: { type: "url", url: "https://example.com/doc.pdf" } },
        { ...callOptions, abortSignal: controller.signal },
      );
      await firstPoll;
      // Let the provider enter its one-second wait before the next poll.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const abortedAt = Date.now();
      controller.abort();
      await expect(execution).rejects.toThrow(/abort/i);
      // Rejection must come from the interrupted wait, not the next poll cycle.
      expect(Date.now() - abortedAt).toBeLessThan(900);
      expect(statusCalls).toBe(1);
    } finally {
      server.stop(true);
    }
  });

  test("threads the exact AI SDK abortSignal into upload, job creation, and status fetches", async () => {
    const controller = new AbortController();
    /** @type {Array<{ url: string; signal: AbortSignal | null | undefined }>} */
    const captured = [];
    const toolset = createDocumentParsingToolset({
      provider: "llamaparse",
      apiKey: "test-key",
      fetch: async (url, init) => {
        captured.push({ url: String(url), signal: init?.signal });
        if (String(url).endsWith("/api/v1/files/")) return Response.json({ id: "file-1" });
        if (String(url).endsWith("/api/v2/parse")) return Response.json({ id: "job-1", status: "PENDING" });
        return Response.json({ job: { id: "job-1", status: "COMPLETED" }, markdown_full: "# Parsed", text_full: "Parsed" });
      },
    });
    await expect(
      toolset.tools.parse_document.execute(
        { source: { type: "base64", data: Buffer.from("pdf bytes").toString("base64"), mimeType: "application/pdf" } },
        { ...callOptions, abortSignal: controller.signal },
      ),
    ).resolves.toMatchObject({ provider: "llamaparse", markdown: "# Parsed", text: "Parsed" });
    expect(captured.map((call) => call.url)).toEqual([
      "https://api.cloud.llamaindex.ai/api/v1/files/",
      "https://api.cloud.llamaindex.ai/api/v2/parse",
      "https://api.cloud.llamaindex.ai/api/v2/parse/job-1?expand=markdown_full,text_full,metadata",
    ]);
    for (const call of captured) expect(call.signal).toBe(controller.signal);
  });

  test("a signal that is already aborted stops polling before the interval wait", async () => {
    const controller = new AbortController();
    let statusCalls = 0;
    const toolset = createDocumentParsingToolset({
      provider: "llamaparse",
      apiKey: "test-key",
      fetch: async (url) => {
        if (String(url).endsWith("/api/v2/parse")) return Response.json({ id: "job-1", status: "PENDING" });
        statusCalls += 1;
        controller.abort();
        return Response.json({ job: { id: "job-1", status: "PENDING" } });
      },
    });
    const startedAt = Date.now();
    await expect(
      toolset.tools.parse_document.execute(
        { source: { type: "url", url: "https://example.com/doc.pdf" } },
        { ...callOptions, abortSignal: controller.signal },
      ),
    ).rejects.toThrow(/abort/i);
    expect(Date.now() - startedAt).toBeLessThan(900);
    expect(statusCalls).toBe(1);
  });
});
