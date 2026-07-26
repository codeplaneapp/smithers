import { describe, expect, test } from "bun:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { AnthropicAgent } from "../src/AnthropicAgent.js";
import { createElevenLabsTextToSpeechTool } from "../src/createElevenLabsTextToSpeechTool.js";
import { createImageGenerationTool } from "../src/image-generation/createImageGenerationTool.js";
import { createTranscriptionTool } from "../src/transcription/createTranscriptionTool.js";

const callOptions = { toolCallId: "test-call", messages: [] };

// ---------------------------------------------------------------------------
// AnthropicAgent — onStdout streaming path (mirror of the OpenAIAgent stream
// test) exercises the generate() branch that pipes super.stream() through
// streamResultToGenerateResult.
// ---------------------------------------------------------------------------
describe("AnthropicAgent streaming", () => {
  test("streams assistant deltas through onStdout", async () => {
    const model = new MockLanguageModelV3({
      modelId: "mock-anthropic-stream",
      doGenerate: async () => ({
        content: [{ type: "text", text: "generate-path" }],
        finishReason: { unified: "stop", raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        warnings: [],
      }),
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "text-1" },
            { type: "text-delta", id: "text-1", delta: "hello" },
            { type: "text-delta", id: "text-1", delta: " anthropic" },
            { type: "text-end", id: "text-1" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: undefined },
              usage: {
                inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: 2, text: 2, reasoning: undefined },
              },
            },
          ],
        }),
      }),
    });
    const agent = new AnthropicAgent({ id: "anthropic-sdk-stream", model });
    let streamed = "";
    const result = await agent.generate({
      prompt: "stream this",
      onStdout: (text) => {
        streamed += text;
      },
    });
    expect(result.text).toBe("hello anthropic");
    expect(streamed).toBe("hello anthropic");
    expect(model.doStreamCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// createElevenLabsTextToSpeechTool — construction guards + execute error paths
// ---------------------------------------------------------------------------
describe("createElevenLabsTextToSpeechTool guards", () => {
  test("throws without an apiKey", () => {
    expect(() => createElevenLabsTextToSpeechTool({})).toThrow(/requires an ElevenLabs apiKey/);
    expect(() => createElevenLabsTextToSpeechTool(undefined)).toThrow(/requires an ElevenLabs apiKey/);
  });

  test("throws when the resolved fetch is not a function", () => {
    expect(() => createElevenLabsTextToSpeechTool({ apiKey: "k", fetch: /** @type {any} */ (42) })).toThrow(
      /requires fetch/,
    );
  });

  test("rejects an empty text argument before calling fetch", async () => {
    let called = 0;
    const toolset = createElevenLabsTextToSpeechTool({
      apiKey: "k",
      fetch: async () => {
        called += 1;
        return new Response(new Uint8Array([1]), { status: 200 });
      },
    });
    await expect(toolset.tools.elevenlabs_text_to_speech.execute({ text: "   " }, callOptions)).rejects.toThrow(
      /requires non-empty text/,
    );
    expect(called).toBe(0);
  });

  test("surfaces a non-ok ElevenLabs response with its status and body", async () => {
    const toolset = createElevenLabsTextToSpeechTool({
      apiKey: "k",
      defaultVoiceId: "v",
      fetch: async () => new Response("upstream boom", { status: 502, statusText: "Bad Gateway" }),
    });
    await expect(toolset.tools.elevenlabs_text_to_speech.execute({ text: "hi" }, callOptions)).rejects.toThrow(
      /failed with 502: upstream boom/,
    );
  });

  test("tolerates a non-ok response whose body cannot be read", async () => {
    const toolset = createElevenLabsTextToSpeechTool({
      apiKey: "k",
      fetch: async () => ({
        ok: false,
        status: 500,
        headers: new Headers(),
        text: async () => {
          throw new Error("body already consumed");
        },
      }),
    });
    await expect(toolset.tools.elevenlabs_text_to_speech.execute({ text: "hi" }, callOptions)).rejects.toThrow(
      /failed with 500$/,
    );
  });

  test("defaults the content-type when the response omits it", async () => {
    const toolset = createElevenLabsTextToSpeechTool({
      apiKey: "k",
      fetch: async () => {
        // A Response built from a body has no explicit content-type header here.
        const r = new Response(new Uint8Array([9, 9]), { status: 200 });
        r.headers.delete("content-type");
        return r;
      },
    });
    const result = await toolset.tools.elevenlabs_text_to_speech.execute(
      { text: "hi", voiceId: "custom", modelId: "custom-model" },
      callOptions,
    );
    expect(result.contentType).toBe("audio/mpeg");
    expect(result.voiceId).toBe("custom");
    expect(result.modelId).toBe("custom-model");
  });
});

// ---------------------------------------------------------------------------
// createImageGenerationTool — invalid provider guard (line 59)
// ---------------------------------------------------------------------------
describe("createImageGenerationTool guards", () => {
  test("throws when the provider is missing or lacks generateImage", () => {
    expect(() => createImageGenerationTool(/** @type {any} */ (null))).toThrow(
      /requires a provider with generateImage/,
    );
    expect(() => createImageGenerationTool(/** @type {any} */ ({}))).toThrow(/requires a provider with generateImage/);
  });

  test("throws on an empty prompt at call time", async () => {
    const tool = createImageGenerationTool({
      async generateImage() {
        return { images: [] };
      },
    });
    await expect(tool.execute({ prompt: "  " }, callOptions)).rejects.toThrow(/requires a non-empty prompt/);
  });
});

// ---------------------------------------------------------------------------
// createTranscriptionTool — error-response handling in assertOk, including the
// text()-rejects catch branch.
// ---------------------------------------------------------------------------
describe("createTranscriptionTool error handling", () => {
  test("throws with status + body when Whisper responds non-ok", async () => {
    const tool = createTranscriptionTool({
      provider: "whisper",
      apiKey: "k",
      fetch: async () => new Response("bad request", { status: 400, statusText: "Bad Request" }),
    });
    await expect(tool.execute({ audioBase64: Buffer.from("x").toString("base64") }, callOptions)).rejects.toThrow(
      /Failed to transcribe audio with Whisper: 400 Bad Request - bad request/,
    );
  });

  test("tolerates a response whose body cannot be read (text() rejects)", async () => {
    const tool = createTranscriptionTool({
      provider: "deepgram",
      apiKey: "k",
      fetch: async () => ({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        text: async () => {
          throw new Error("stream already consumed");
        },
      }),
    });
    await expect(tool.execute({ audioUrl: "https://example.com/a.mp3" }, callOptions)).rejects.toThrow(
      /Failed to transcribe audio with Deepgram: 503 Service Unavailable$/,
    );
  });

  test("rejects an unsupported provider", async () => {
    const tool = createTranscriptionTool({
      provider: /** @type {any} */ ("nope"),
      apiKey: "k",
      fetch: async () => new Response("{}", { status: 200 }),
    });
    await expect(tool.execute({ audioBase64: Buffer.from("x").toString("base64") }, callOptions)).rejects.toThrow(
      /Unsupported transcription provider: nope/,
    );
  });

  test("throws when the resolved fetch is not a function", () => {
    expect(() => createTranscriptionTool({ provider: "whisper", apiKey: "k", fetch: /** @type {any} */ (5) })).toThrow(
      /requires fetch to be available/,
    );
  });

  function whisperTool(extra) {
    return createTranscriptionTool({
      provider: "whisper",
      apiKey: "k",
      fetch: async () => Response.json({ text: "should not reach" }),
      ...extra,
    });
  }

  test("requires exactly one of audioUrl or audioBase64", async () => {
    await expect(whisperTool().execute({}, callOptions)).rejects.toThrow(/requires either audioUrl or audioBase64/);
    await expect(
      whisperTool().execute(
        { audioUrl: "https://example.com/a.mp3", audioBase64: Buffer.from("x").toString("base64") },
        callOptions,
      ),
    ).rejects.toThrow(/only one of audioUrl or audioBase64/);
  });

  test("rejects an unparseable audioUrl", async () => {
    await expect(whisperTool().execute({ audioUrl: "http://[not a url" }, callOptions)).rejects.toThrow(
      /Invalid audioUrl/,
    );
  });

  test("rejects a host outside allowedAudioHosts", async () => {
    await expect(
      whisperTool({ allowedAudioHosts: ["allowed.example"] }).execute(
        { audioUrl: "https://other.example/a.mp3" },
        callOptions,
      ),
    ).rejects.toThrow(/is not in allowedAudioHosts/);
  });

  const blockedHosts = [
    ["this-host 0.0.0.0", "http://0.0.0.0/a.wav"],
    ["private 172.16", "http://172.16.0.9/a.wav"],
    ["private 192.168", "http://192.168.1.9/a.wav"],
    ["CGNAT 100.64", "http://100.100.0.9/a.wav"],
    ["multicast 224", "http://224.0.0.9/a.wav"],
    ["IPv6 mapped-hex loopback", "http://[::ffff:7f00:1]/a.wav"],
    ["IPv6 link-local fe80", "http://[fe80::1]/a.wav"],
    ["IPv6 unique-local fc00", "http://[fc00::1]/a.wav"],
    ["dotted .local mDNS", "http://printer.local/a.wav"],
  ];
  for (const [label, audioUrl] of blockedHosts) {
    test(`refuses a blocked audio host (${label})`, async () => {
      let called = 0;
      const tool = createTranscriptionTool({
        provider: "whisper",
        apiKey: "k",
        fetch: async () => {
          called += 1;
          return Response.json({ text: "leaked" });
        },
      });
      await expect(tool.execute({ audioUrl }, callOptions)).rejects.toThrow(/private, loopback, or link-local/i);
      expect(called).toBe(0);
    });
  }

  test("refuses a non-http(s) scheme", async () => {
    await expect(whisperTool().execute({ audioUrl: "file:///etc/passwd" }, callOptions)).rejects.toThrow(/http\(s\)/i);
  });

  test("transcribes a Deepgram audioUrl and normalizes duration", async () => {
    const tool = createTranscriptionTool({
      provider: "deepgram",
      apiKey: "k",
      model: "nova-2",
      fetch: async () =>
        Response.json({
          metadata: { duration: 4.5 },
          results: { channels: [{ alternatives: [{ transcript: "dg words" }] }] },
        }),
    });
    const result = await tool.execute({ audioUrl: "https://example.com/a.mp3", language: "en" }, callOptions);
    expect(result).toEqual({ text: "dg words", durationSeconds: 4.5, provider: "deepgram" });
  });

  test("allowedAudioHosts opts a public host in and transcribes", async () => {
    let downloaded = false;
    const tool = createTranscriptionTool({
      provider: "whisper",
      apiKey: "k",
      allowedAudioHosts: ["cdn.example"],
      audioUrlResolver: async () => [{ address: "93.184.216.34", family: 4 }],
      audioUrlTransport: async (request) => {
        downloaded = request.url.href === "https://cdn.example/a.mp3";
        return new Response(new Blob([Buffer.from("a")]), {
          headers: { "content-type": "audio/mpeg" },
        });
      },
      fetch: async () => Response.json({ text: "allowlisted transcript" }),
    });
    const result = await tool.execute({ audioUrl: "https://cdn.example/a.mp3" }, callOptions);
    expect(downloaded).toBe(true);
    expect(result.text).toBe("allowlisted transcript");
  });

  test("allows a public IPv4 host and transcribes it", async () => {
    let downloaded = false;
    const tool = createTranscriptionTool({
      provider: "whisper",
      apiKey: "k",
      audioUrlTransport: async (request) => {
        downloaded = request.url.href === "http://8.8.8.8/a.mp3" && request.address === "8.8.8.8";
        return new Response(new Blob([Buffer.from("a")]), {
          headers: { "content-type": "audio/mpeg" },
        });
      },
      fetch: async () => Response.json({ text: "public ipv4 transcript" }),
    });
    const result = await tool.execute({ audioUrl: "http://8.8.8.8/a.mp3" }, callOptions);
    expect(downloaded).toBe(true);
    expect(result.text).toBe("public ipv4 transcript");
  });

  test("allows a public IPv6 host and transcribes it", async () => {
    let downloaded = false;
    const tool = createTranscriptionTool({
      provider: "whisper",
      apiKey: "k",
      audioUrlTransport: async (request) => {
        downloaded =
          request.url.href === "http://[2606:4700:808:808:8:808:808:808]/a.mp3" &&
          request.address === "2606:4700:808:808:8:808:808:808";
        return new Response(new Blob([Buffer.from("audio")]), {
          headers: { "content-type": "audio/mpeg" },
        });
      },
      fetch: async () => Response.json({ text: "public ipv6 transcript", language: "en", duration: 2 }),
    });
    const result = await tool.execute({ audioUrl: "http://[2606:4700:808:808:8:808:808:808]/a.mp3" }, callOptions);
    expect(downloaded).toBe(true);
    expect(result.text).toBe("public ipv6 transcript");
  });
});
