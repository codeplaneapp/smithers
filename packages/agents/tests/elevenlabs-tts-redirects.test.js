import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createElevenLabsTextToSpeechTool } from "../src/createElevenLabsTextToSpeechTool.js";

/** AI SDK passes these to `execute`; the TTS tool ignores them. */
const callOptions = { toolCallId: "test-call", messages: [] };
const API_KEY = "secret-eleven-key";
const AUDIO_BYTES = new Uint8Array([1, 2, 3]);

/** @type {Array<{ server: string; method: string; pathname: string; xiApiKey: string | null; body: string }>} */
const requests = [];

let authorizedServer;
let authorizedUrl;
let attackerServer;
let attackerUrl;
let secondAttackerServer;
let secondAttackerUrl;

/**
 * @param {string} name
 * @param {(request: Request, url: URL) => Response | Promise<Response>} route
 */
function recordingHandler(name, route) {
  /** @param {Request} request */
  return async (request) => {
    const url = new URL(request.url);
    requests.push({
      server: name,
      method: request.method,
      pathname: url.pathname,
      xiApiKey: request.headers.get("xi-api-key"),
      body: await request.text(),
    });
    return route(request, url);
  };
}

function audioResponse() {
  return new Response(AUDIO_BYTES, { status: 200, headers: { "content-type": "audio/mpeg" } });
}

beforeAll(() => {
  secondAttackerServer = Bun.serve({
    port: 0,
    fetch: recordingHandler("attacker2", () => audioResponse()),
  });
  secondAttackerUrl = `http://${secondAttackerServer.hostname}:${secondAttackerServer.port}`;

  attackerServer = Bun.serve({
    port: 0,
    fetch: recordingHandler("attacker1", (_request, url) => {
      if (url.pathname === "/hop1") {
        return new Response(null, { status: 302, headers: { location: `${secondAttackerUrl}/hop2` } });
      }
      return audioResponse();
    }),
  });
  attackerUrl = `http://${attackerServer.hostname}:${attackerServer.port}`;

  authorizedServer = Bun.serve({
    port: 0,
    fetch: recordingHandler("authorized", (_request, url) => {
      if (url.pathname === "/v1/text-to-speech/same_origin") {
        return new Response(null, { status: 307, headers: { location: "/moved-tts" } });
      }
      if (url.pathname === "/moved-tts") {
        return audioResponse();
      }
      if (url.pathname === "/v1/text-to-speech/cross_origin") {
        return new Response(null, { status: 302, headers: { location: `${attackerUrl}/capture` } });
      }
      if (url.pathname === "/v1/text-to-speech/multi_hop") {
        return new Response(null, { status: 302, headers: { location: `${attackerUrl}/hop1` } });
      }
      if (url.pathname === "/v1/text-to-speech/loop") {
        return new Response(null, { status: 302, headers: { location: "/v1/text-to-speech/loop" } });
      }
      if (url.pathname === "/v1/text-to-speech/bad_protocol") {
        return new Response(null, { status: 302, headers: { location: "ftp://evil.example/capture" } });
      }
      return audioResponse();
    }),
  });
  authorizedUrl = `http://${authorizedServer.hostname}:${authorizedServer.port}`;
});

afterAll(() => {
  authorizedServer?.stop(true);
  attackerServer?.stop(true);
  secondAttackerServer?.stop(true);
});

function createToolset() {
  return createElevenLabsTextToSpeechTool({ apiKey: API_KEY, baseUrl: authorizedUrl });
}

/** @param {string} voiceId */
async function synthesize(voiceId) {
  const toolset = createToolset();
  return toolset.tools.elevenlabs_text_to_speech.execute({ text: "hello", voiceId }, callOptions);
}

describe("createElevenLabsTextToSpeechTool redirect hardening", () => {
  test("same-origin redirects still work and keep xi-api-key on every hop", async () => {
    requests.length = 0;

    const result = await synthesize("same_origin");

    expect(result.audioBase64).toBe(Buffer.from(AUDIO_BYTES).toString("base64"));
    expect(result.byteLength).toBe(3);
    expect(requests.map((r) => `${r.server}:${r.pathname}`)).toEqual([
      "authorized:/v1/text-to-speech/same_origin",
      "authorized:/moved-tts",
    ]);
    for (const request of requests) {
      expect(request.xiApiKey).toBe(API_KEY);
    }
    // 307 preserves the method and body across the same-origin hop.
    expect(requests[1].method).toBe("POST");
    expect(JSON.parse(requests[1].body).text).toBe("hello");
  });

  test("cross-origin redirects fail before the foreign origin receives a request", async () => {
    requests.length = 0;

    await expect(synthesize("cross_origin")).rejects.toThrow(/cross-origin/);

    const authorized = requests.filter((r) => r.server === "authorized");
    expect(authorized).toHaveLength(1);
    expect(authorized[0].xiApiKey).toBe(API_KEY);

    const attacker = requests.filter((r) => r.server === "attacker1");
    expect(attacker).toHaveLength(0);
  });

  test("multi-hop redirect chains fail closed at the first foreign origin", async () => {
    requests.length = 0;

    await expect(synthesize("multi_hop")).rejects.toThrow(/cross-origin/);

    expect(requests.map((r) => `${r.server}:${r.pathname}`)).toEqual([
      "authorized:/v1/text-to-speech/multi_hop",
    ]);
    expect(requests[0].xiApiKey).toBe(API_KEY);
  });

  test("redirect loops fail instead of following forever", async () => {
    requests.length = 0;

    await expect(synthesize("loop")).rejects.toThrow(/exceeded 5 redirects/);
    expect(requests.length).toBe(6);
  });

  test("redirects to non-http(s) protocols are refused", async () => {
    requests.length = 0;

    await expect(synthesize("bad_protocol")).rejects.toThrow(/unsupported protocol/);
    expect(requests.filter((r) => r.server !== "authorized")).toHaveLength(0);
  });
});
