import { afterEach, describe, expect, mock, test } from "bun:test";
import { createElevenLabsTextToSpeechTool } from "../src/createElevenLabsTextToSpeechTool.js";
import { createDocumentParsingToolset } from "../src/document-parsing/createDocumentParsingToolset.js";
import { createHttpTool } from "../src/http/createHttpTool.js";
import { createTranscriptionTool } from "../src/transcription/createTranscriptionTool.js";
import { fetchSearchJson } from "../src/web-search/searchHttp.js";

const originalFetch = globalThis.fetch;
const callOptions = { toolCallId: "response-limit", messages: [] };

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("response limit configuration is side-effect free", () => {
  test("the generic HTTP tool rejects an invalid cap before fetch", async () => {
    const fetchSpy = mock(async () => Response.json({ contacted: true }));
    globalThis.fetch = fetchSpy;
    const tool = createHttpTool({
      allowPrivateNetwork: true,
      maxResponseBytes: -1,
    });

    await expect(tool.execute({ url: "https://example.com" }, callOptions))
      .rejects.toMatchObject({
        code: "INVALID_OPTION",
        details: { option: "maxResponseBytes" },
      });
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });

  test("ElevenLabs rejects an invalid cap before its transport can run", () => {
    const fetchSpy = mock(async () => new Response("audio"));
    expect(() => createElevenLabsTextToSpeechTool({
      apiKey: "eleven-key",
      fetch: fetchSpy,
      maxResponseBytes: Number.NaN,
    })).toThrow(expect.objectContaining({
      code: "INVALID_OPTION",
      details: { option: "maxResponseBytes" },
    }));
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });

  test.each(["whisper", "deepgram"])(
    "%s transcription rejects invalid response and audio caps before fetch",
    (provider) => {
      for (const invalidOptions of [
        { maxResponseBytes: -1 },
        { maxAudioBytes: Number.POSITIVE_INFINITY },
      ]) {
        const fetchSpy = mock(async () => Response.json({ contacted: true }));
        expect(() => createTranscriptionTool({
          provider,
          apiKey: "transcription-key",
          fetch: fetchSpy,
          ...invalidOptions,
        })).toThrow(expect.objectContaining({ code: "INVALID_OPTION" }));
        expect(fetchSpy).toHaveBeenCalledTimes(0);
      }
    },
  );

  test("document parsing rejects an invalid response cap before provider setup", () => {
    const fetchSpy = mock(async () => Response.json({ contacted: true }));
    expect(() => createDocumentParsingToolset({
      apiKey: "document-key",
      fetch: fetchSpy,
      maxResponseBytes: 1.5,
    })).toThrow(expect.objectContaining({
      code: "INVALID_OPTION",
      details: { option: "maxResponseBytes" },
    }));
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });

  test("search transport rejects an invalid response cap before fetch", async () => {
    const fetchSpy = mock(async () => Response.json({ contacted: true }));
    await expect(fetchSearchJson(
      "https://example.com/search",
      {},
      {
        provider: "fixture",
        fetch: fetchSpy,
        maxResponseBytes: Number.MAX_SAFE_INTEGER + 1,
      },
    )).rejects.toMatchObject({
      code: "INVALID_OPTION",
      details: { option: "maxResponseBytes" },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });
});
