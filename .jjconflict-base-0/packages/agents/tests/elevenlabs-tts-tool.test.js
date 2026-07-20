import { describe, expect, test } from "bun:test";
import { createElevenLabsTextToSpeechTool } from "../src/index.js";

const callOptions = { toolCallId: "test-call", messages: [] };

describe("createElevenLabsTextToSpeechTool", () => {
  test("creates an agent-callable ElevenLabs TTS tool", async () => {
    /** @type {Array<{ url: string; init: RequestInit }>} */
    const calls = [];
    const toolset = createElevenLabsTextToSpeechTool({
      apiKey: "test-eleven-key",
      defaultVoiceId: "voice_123",
      defaultModelId: "eleven_turbo_v2_5",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: /** @type {RequestInit} */ (init ?? {}) });
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        });
      },
    });

    expect(toolset.toolNames).toEqual(["elevenlabs_text_to_speech"]);
    expect(typeof toolset.tools.elevenlabs_text_to_speech.execute).toBe("function");

    const result = await toolset.tools.elevenlabs_text_to_speech.execute(
      { text: "Hello from Smithers", voiceSettings: { stability: 0.4 } },
      callOptions,
    );

    expect(result).toEqual({
      audioBase64: "AQID",
      contentType: "audio/mpeg",
      voiceId: "voice_123",
      modelId: "eleven_turbo_v2_5",
      byteLength: 3,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.elevenlabs.io/v1/text-to-speech/voice_123");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers).toEqual({
      Accept: "audio/mpeg",
      "Content-Type": "application/json",
      "xi-api-key": "test-eleven-key",
    });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      text: "Hello from Smithers",
      model_id: "eleven_turbo_v2_5",
      voice_settings: { stability: 0.4 },
    });
  });
});
