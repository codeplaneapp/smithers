import { describe, expect, mock, test } from "bun:test";
import { createTranscriptionTool } from "../src/transcription/createTranscriptionTool.js";

const encoder = new TextEncoder();
const callOptions = { toolCallId: "response-size", messages: [] };
const audioUrl = "https://cdn.example.com/audio.mp3";

describe("createTranscriptionTool downloaded response body size limit", () => {
  test("accepts an optionless audio response just over 1 MiB and uploads it", async () => {
    const audioBytes = new Uint8Array(1_048_577);
    audioBytes.fill(7);
    const streamed = makeStreamResponse([audioBytes], {
      "content-length": String(audioBytes.byteLength),
      "content-type": "audio/mpeg",
    });
    let uploadedBytes;
    const providerFetch = mock(async (_url, init) => {
      const file = init.body.get("file");
      uploadedBytes = new Uint8Array(await file.arrayBuffer());
      return Response.json({ text: "large transcript" });
    });
    const harness = createWhisperHarness(streamed.response, { fetch: providerFetch });

    const result = await harness.tool.execute({ audioUrl }, callOptions);

    expect(result).toEqual({ text: "large transcript", provider: "whisper" });
    expect(uploadedBytes).toEqual(audioBytes);
    expect(providerFetch).toHaveBeenCalledTimes(1);
  });

  test("rejects an optionless audio response over 25 MiB before acquiring a reader", async () => {
    const getReader = mock(() => {
      throw new Error("body reader must not be acquired");
    });
    const cancel = mock(async () => {});
    const harness = createWhisperHarness({
      status: 200,
      statusText: "OK",
      ok: true,
      headers: new Headers({
        "content-length": "26214401",
        "content-type": "audio/mpeg",
      }),
      body: { getReader, cancel },
    });

    const error = await captureRejection(harness.tool.execute({ audioUrl }, callOptions));

    expect(String(error)).toMatch(/maxResponseBodyBytes.*26214400/);
    expect(getReader).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(harness.providerFetch).not.toHaveBeenCalled();
  });

  test("counts a chunked audio response and stops reading as soon as it crosses the cap", async () => {
    const streamed = makeStreamResponse(["1234", "56789", "unread"]);
    const harness = createWhisperHarness(streamed.response, { maxResponseBytes: 8 });

    const error = await captureRejection(harness.tool.execute({ audioUrl }, callOptions));

    expect(String(error)).toMatch(/exceeds 8 bytes/);
    expect(streamed.pullCount()).toBe(2);
    expect(streamed.cancelReason()).toBeInstanceOf(Error);
    expect(String(streamed.cancelReason())).toMatch(/exceeds 8 bytes/);
    expect(harness.providerFetch).not.toHaveBeenCalled();
  });

  test("accepts and uploads an audio response exactly at the cap", async () => {
    const audioBytes = encoder.encode("audio123");
    const streamed = makeStreamResponse(
      [audioBytes.slice(0, 3), audioBytes.slice(3)],
      {
        "content-length": String(audioBytes.byteLength),
        "content-type": "audio/mpeg",
      },
    );
    let uploadedBytes;
    const providerFetch = mock(async (_url, init) => {
      const file = init.body.get("file");
      uploadedBytes = new Uint8Array(await file.arrayBuffer());
      return Response.json({ text: "exact transcript" });
    });
    const harness = createWhisperHarness(streamed.response, {
      maxResponseBodyBytes: audioBytes.byteLength,
      fetch: providerFetch,
    });

    const result = await harness.tool.execute({ audioUrl }, callOptions);

    expect(result).toEqual({ text: "exact transcript", provider: "whisper" });
    expect(uploadedBytes).toEqual(audioBytes);
    expect(streamed.cancelReason()).toBeUndefined();
    expect(streamed.response.body.locked).toBe(false);
  });

  test("cancels and releases the audio reader after streamed overflow", async () => {
    const reader = makeOverflowReader();
    const harness = createWhisperHarness(responseWithReader(reader), {
      maxResponseBodyBytes: 4,
    });

    const error = await captureRejection(harness.tool.execute({ audioUrl }, callOptions));

    expect(String(error)).toMatch(/maxResponseBodyBytes.*4/);
    expect(reader.read).toHaveBeenCalledTimes(2);
    expect(reader.cancel).toHaveBeenCalledTimes(1);
    expect(reader.cancel.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(reader.releaseLock).toHaveBeenCalledTimes(1);
    expect(harness.providerFetch).not.toHaveBeenCalled();
  });

  test("external abort cancels an in-progress audio read and preserves the abort reason", async () => {
    const blocked = makeBlockedReader();
    const harness = createWhisperHarness(responseWithReader(blocked.reader), {
      maxResponseBodyBytes: 100,
    });
    const controller = new AbortController();
    const pending = harness.tool.execute(
      { audioUrl },
      { ...callOptions, abortSignal: controller.signal },
    );

    await blocked.readStarted;
    controller.abort(new Error("stop transcription audio read"));
    const error = await captureRejection(pending);

    expect(String(error)).toContain("stop transcription audio read");
    expect(blocked.reader.cancel).toHaveBeenCalledTimes(1);
    expect(blocked.reader.releaseLock).toHaveBeenCalledTimes(1);
    expect(harness.providerFetch).not.toHaveBeenCalled();
  });

  test("rejects invalid maxResponseBodyBytes values when the tool is created", () => {
    for (const value of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        createTranscriptionTool({
          provider: "whisper",
          apiKey: "openai-test-key",
          maxResponseBodyBytes: value,
        }),
      ).toThrow("maxResponseBodyBytes must be a positive safe integer");
    }
  });
});

/**
 * @param {Response | object} audioResponse
 * @param {Record<string, unknown>} [overrides]
 */
function createWhisperHarness(audioResponse, overrides = {}) {
  const providerFetch = overrides.fetch ?? mock(async () => Response.json({ text: "unexpected" }));
  const tool = createTranscriptionTool({
    provider: "whisper",
    apiKey: "openai-test-key",
    audioUrlResolver: async () => [{ address: "8.8.8.8", family: 4 }],
    audioUrlTransport: async () => audioResponse,
    ...overrides,
    fetch: providerFetch,
  });
  return { tool, providerFetch };
}

/**
 * @param {Array<string | Uint8Array>} chunks
 * @param {HeadersInit} [headers]
 */
function makeStreamResponse(chunks, headers = { "content-type": "audio/mpeg" }) {
  const queued = chunks.map((chunk) => typeof chunk === "string" ? encoder.encode(chunk) : chunk);
  let pulls = 0;
  let cancelledWith;
  const body = new ReadableStream({
    pull(controller) {
      pulls += 1;
      const chunk = queued.shift();
      if (chunk === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(chunk);
    },
    cancel(reason) {
      cancelledWith = reason;
    },
  }, { highWaterMark: 0 });
  const response = new Response(body, { headers });
  return {
    response,
    pullCount: () => pulls,
    cancelReason: () => cancelledWith,
  };
}

function makeOverflowReader() {
  const reads = [
    { done: false, value: encoder.encode("1234") },
    { done: false, value: encoder.encode("5") },
  ];
  return {
    read: mock(async () => reads.shift() ?? { done: true, value: undefined }),
    cancel: mock(async () => {}),
    releaseLock: mock(() => {}),
  };
}

function makeBlockedReader() {
  let resolveRead;
  let markReadStarted;
  const readStarted = new Promise((resolve) => {
    markReadStarted = resolve;
  });
  const reader = {
    read: mock(async () => {
      markReadStarted();
      return new Promise((resolve) => {
        resolveRead = resolve;
      });
    }),
    cancel: mock(async () => {
      resolveRead?.({ done: true, value: undefined });
    }),
    releaseLock: mock(() => {}),
  };
  return { reader, readStarted };
}

/** @param {{ read: Function, cancel: Function, releaseLock: Function }} reader */
function responseWithReader(reader) {
  return {
    status: 200,
    statusText: "OK",
    ok: true,
    headers: new Headers({ "content-type": "audio/mpeg" }),
    body: {
      getReader: () => reader,
      cancel: mock(async () => {}),
    },
  };
}

/** @param {Promise<unknown>} promise */
async function captureRejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected promise to reject");
}
