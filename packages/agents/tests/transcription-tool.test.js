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

  const ssrfAudioUrls = [
    ["cloud metadata", "http://169.254.169.254/latest/meta-data/iam/security-credentials/"],
    ["loopback IPv4", "http://127.0.0.1/secret"],
    ["private IPv4", "http://10.0.0.5/internal"],
    ["localhost name", "http://localhost:8080/audio.wav"],
    ["IPv6 loopback", "http://[::1]/audio.wav"],
    ["IPv4-mapped loopback", "http://[::ffff:127.0.0.1]/audio.wav"],
  ];
  for (const [label, audioUrl] of ssrfAudioUrls) {
    test(`refuses to fetch an SSRF audioUrl (${label}) before any request`, async () => {
      let called = 0;
      const transcription = createTranscriptionTool({
        provider: "whisper",
        apiKey: "openai-test-key",
        fetch: async () => {
          called += 1;
          return Response.json({ text: "leaked" });
        },
      });

      await expect(transcription.execute({ audioUrl }, callOptions)).rejects.toThrow(
        /private, loopback, or link-local/i,
      );
      expect(called).toBe(0);
    });
  }

  test("refuses a non-http(s) audioUrl scheme", async () => {
    let called = 0;
    const transcription = createTranscriptionTool({
      provider: "whisper",
      apiKey: "openai-test-key",
      fetch: async () => {
        called += 1;
        return Response.json({ text: "leaked" });
      },
    });

    await expect(transcription.execute({ audioUrl: "file:///etc/passwd" }, callOptions)).rejects.toThrow(
      /http\(s\)/i,
    );
    expect(called).toBe(0);
  });

  test("still downloads and transcribes a legitimate public audioUrl", async () => {
    const requests = [];
    const transcription = createTranscriptionTool({
      provider: "whisper",
      apiKey: "openai-test-key",
      fetch: async (url, init) => {
        requests.push(String(url));
        if (String(url) === "https://cdn.example.com/audio.mp3") {
          return new Response(new Blob([Buffer.from("audio bytes")]), {
            headers: { "content-type": "audio/mpeg" },
          });
        }
        return Response.json({ text: "public transcript", language: "en", duration: 3 });
      },
    });

    const result = await transcription.execute({ audioUrl: "https://cdn.example.com/audio.mp3" }, callOptions);

    expect(result).toEqual({ text: "public transcript", language: "en", durationSeconds: 3, provider: "whisper" });
    expect(requests[0]).toBe("https://cdn.example.com/audio.mp3");
    expect(requests[1]).toBe("https://api.openai.com/v1/audio/transcriptions");
  });

  test("allowedAudioHosts opts a private host back in on purpose", async () => {
    let downloaded = false;
    const transcription = createTranscriptionTool({
      provider: "whisper",
      apiKey: "openai-test-key",
      allowedAudioHosts: ["127.0.0.1"],
      fetch: async (url) => {
        if (String(url) === "http://127.0.0.1:9000/audio.mp3") {
          downloaded = true;
          return new Response(new Blob([Buffer.from("audio bytes")]), {
            headers: { "content-type": "audio/mpeg" },
          });
        }
        return Response.json({ text: "internal transcript" });
      },
    });

    const result = await transcription.execute({ audioUrl: "http://127.0.0.1:9000/audio.mp3" }, callOptions);

    expect(downloaded).toBe(true);
    expect(result.text).toBe("internal transcript");
  });
});
