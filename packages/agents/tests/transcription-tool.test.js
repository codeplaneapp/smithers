import { describe, expect, test } from "bun:test";
import { createTranscriptionTool } from "../src/transcription/createTranscriptionTool.js";

const callOptions = { toolCallId: "test-call", messages: [] };

describe("createTranscriptionTool", () => {
  test("posts audio to Whisper and returns normalized transcript text", async () => {
    const requests = [];
    const transcription = createTranscriptionTool({
      provider: "whisper",
      apiKey: "openai-test-key",
      fetch: async (url, init) => {
        requests.push({ url, init });
        return Response.json({ text: "hello from audio", language: "en", duration: 1.25 });
      },
    });

    const result = await transcription.execute(
      { audioBase64: Buffer.from("audio bytes").toString("base64"), mimeType: "audio/wav" },
      callOptions,
    );

    expect(result).toEqual({ text: "hello from audio", language: "en", durationSeconds: 1.25, provider: "whisper" });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(requests[0].init.method).toBe("POST");
    expect(requests[0].init.headers.Authorization).toBe("Bearer openai-test-key");
    expect(requests[0].init.body).toBeInstanceOf(FormData);
  });

  test("posts audio URLs to Deepgram and normalizes the first alternative", async () => {
    const requests = [];
    const transcription = createTranscriptionTool({
      provider: "deepgram",
      apiKey: "deepgram-test-key",
      fetch: async (url, init) => {
        requests.push({ url, init });
        return Response.json({
          metadata: { duration: 2.5 },
          results: { channels: [{ alternatives: [{ transcript: "deepgram transcript" }] }] },
        });
      },
    });

    const result = await transcription.execute({ audioUrl: "https://example.com/audio.mp3" }, callOptions);

    expect(result).toEqual({ text: "deepgram transcript", durationSeconds: 2.5, provider: "deepgram" });
    expect(requests[0].url).toBe("https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true");
    expect(requests[0].init.headers.Authorization).toBe("Token deepgram-test-key");
    expect(JSON.parse(requests[0].init.body)).toEqual({ url: "https://example.com/audio.mp3" });
  });
});
