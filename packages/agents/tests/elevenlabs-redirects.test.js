import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createElevenLabsTextToSpeechTool } from "../src/createElevenLabsTextToSpeechTool.js";

const callOptions = { toolCallId: "tts-redirect", messages: [] };
let api;
let receiver;
let apiUrl;
let receiverUrl;
let receiverHits = 0;

beforeAll(() => {
  receiver = Bun.serve({
    port: 0,
    fetch: (request) => {
      receiverHits += 1;
      return new Response(request.headers.get("xi-api-key") ?? "stripped", {
        headers: { "content-type": "audio/mpeg" },
      });
    },
  });
  receiverUrl = `http://127.0.0.1:${receiver.port}`;
  api = Bun.serve({
    port: 0,
    fetch: (request) => {
      const path = new URL(request.url).pathname;
      if (path.startsWith("/same/v1/")) {
        return new Response(null, { status: 307, headers: { location: "/target" } });
      }
      if (path.startsWith("/cross/v1/")) {
        return new Response(null, { status: 307, headers: { location: `${receiverUrl}/target` } });
      }
      if (path.startsWith("/multi/v1/")) {
        return new Response(null, { status: 302, headers: { location: "/multi-hop" } });
      }
      if (path === "/multi-hop") {
        return new Response(null, { status: 307, headers: { location: `${receiverUrl}/target` } });
      }
      return new Response(request.headers.get("xi-api-key") ?? "stripped", {
        headers: { "content-type": "audio/mpeg" },
      });
    },
  });
  apiUrl = `http://127.0.0.1:${api.port}`;
});

afterAll(() => {
  api?.stop(true);
  receiver?.stop(true);
});

function tool(mode, allowedOrigins) {
  return createElevenLabsTextToSpeechTool({
    apiKey: "eleven-secret",
    baseUrl: `${apiUrl}/${mode}`,
    allowedOrigins,
  }).tools.elevenlabs_text_to_speech;
}

describe("ElevenLabs credential-safe redirects", () => {
  test("retains xi-api-key on a same-origin redirect", async () => {
    const result = await tool("same").execute({ text: "hello" }, callOptions);
    expect(Buffer.from(result.audioBase64, "base64").toString()).toBe("eleven-secret");
  });

  test("blocks a body-preserving redirect to an unauthorized origin", async () => {
    await expect(tool("cross").execute({ text: "hello" }, callOptions)).rejects.toMatchObject({
      code: "CROSS_ORIGIN_BODY_BLOCKED",
    });
  });

  test("fails closed when a later redirect hop crosses origin", async () => {
    receiverHits = 0;
    await expect(tool("multi").execute({ text: "hello" }, callOptions)).rejects.toMatchObject({
      message: expect.stringContaining("cross-origin"),
    });
    expect(receiverHits).toBe(0);
  });

  test("retains xi-api-key only for an explicitly authorized origin", async () => {
    const result = await tool("cross", [receiverUrl]).execute({ text: "hello" }, callOptions);
    expect(Buffer.from(result.audioBase64, "base64").toString()).toBe("eleven-secret");
  });

  test("bounds the audio response body", async () => {
    const bounded = createElevenLabsTextToSpeechTool({
      apiKey: "eleven-secret",
      baseUrl: `${apiUrl}/same`,
      maxResponseBytes: 4,
    }).tools.elevenlabs_text_to_speech;
    await expect(bounded.execute({ text: "hello" }, callOptions)).rejects.toMatchObject({
      code: "RESPONSE_TOO_LARGE",
    });
  });

  test("redacts a reflected API key from provider errors", async () => {
    const reflected = createElevenLabsTextToSpeechTool({
      apiKey: "eleven-secret",
      fetch: async () => new Response("received xi-api-key=eleven-secret", { status: 500 }),
    }).tools.elevenlabs_text_to_speech;

    let caught;
    try {
      await reflected.execute({ text: "hello" }, callOptions);
    } catch (error) {
      caught = error;
    }
    expect(caught?.message).toContain("[REDACTED]");
    expect(caught?.message).not.toContain("eleven-secret");
  });

  test("preserves cancellation while reading a non-2xx error body", async () => {
    const controller = new AbortController();
    let markReading;
    const reading = new Promise((resolve) => {
      markReading = resolve;
    });
    const cancelled = createElevenLabsTextToSpeechTool({
      apiKey: "eleven-secret",
      fetch: async () => new Response(new ReadableStream({
        pull() {
          markReading();
        },
      }), { status: 500 }),
    }).tools.elevenlabs_text_to_speech;
    const reason = new DOMException("cancelled", "AbortError");
    const pending = cancelled.execute(
      { text: "hello" },
      { ...callOptions, abortSignal: controller.signal },
    );
    await reading;
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });
});
