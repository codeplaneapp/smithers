import { dynamicTool, jsonSchema } from "ai";

const DEFAULT_BASE_URL = "https://api.elevenlabs.io";
const DEFAULT_MODEL_ID = "eleven_turbo_v2_5";
const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";
const TOOL_NAME = "elevenlabs_text_to_speech";

const inputSchema = {
  type: "object",
  properties: {
    text: {
      type: "string",
      minLength: 1,
      description: "Text to synthesize into speech.",
    },
    voiceId: {
      type: "string",
      minLength: 1,
      description: "Optional ElevenLabs voice id. Defaults to the configured voice.",
    },
    modelId: {
      type: "string",
      minLength: 1,
      description: "Optional ElevenLabs model id. Defaults to the configured model.",
    },
    voiceSettings: {
      type: "object",
      additionalProperties: true,
      description: "Optional ElevenLabs voice_settings payload.",
    },
  },
  required: ["text"],
  additionalProperties: false,
};

/**
 * Create an agent-callable ElevenLabs text-to-speech tool.
 *
 * @param {import("./createElevenLabsTextToSpeechTool.ts").ElevenLabsTextToSpeechToolOptions} options
 * @returns {import("./createElevenLabsTextToSpeechTool.ts").ElevenLabsTextToSpeechToolset}
 */
export function createElevenLabsTextToSpeechTool(options) {
  if (!options?.apiKey) {
    throw new Error("createElevenLabsTextToSpeechTool requires an ElevenLabs apiKey");
  }

  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("createElevenLabsTextToSpeechTool requires fetch");
  }

  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const defaultVoiceId = options.defaultVoiceId ?? DEFAULT_VOICE_ID;
  const defaultModelId = options.defaultModelId ?? DEFAULT_MODEL_ID;

  return {
    tools: {
      [TOOL_NAME]: dynamicTool({
        description: "Synthesize speech audio from text using ElevenLabs.",
        inputSchema: jsonSchema(inputSchema),
        execute: async (input) =>
          synthesizeSpeech({
            apiKey: options.apiKey,
            baseUrl,
            defaultVoiceId,
            defaultModelId,
            fetchImpl,
            input,
          }),
      }),
    },
    toolNames: [TOOL_NAME],
  };
}

/**
 * @param {{
 *   apiKey: string;
 *   baseUrl: string;
 *   defaultVoiceId: string;
 *   defaultModelId: string;
 *   fetchImpl: typeof fetch;
 *   input: unknown;
 * }} params
 */
async function synthesizeSpeech({ apiKey, baseUrl, defaultVoiceId, defaultModelId, fetchImpl, input }) {
  const args = /** @type {import("./createElevenLabsTextToSpeechTool.ts").ElevenLabsTextToSpeechInput} */ (
    input ?? {}
  );
  if (typeof args.text !== "string" || args.text.trim() === "") {
    throw new Error("elevenlabs_text_to_speech requires non-empty text");
  }

  const voiceId = args.voiceId ?? defaultVoiceId;
  const modelId = args.modelId ?? defaultModelId;
  const body = {
    text: args.text,
    model_id: modelId,
    ...(args.voiceSettings ? { voice_settings: args.voiceSettings } : {}),
  };

  const response = await fetchImpl(`${baseUrl}/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
    method: "POST",
    headers: {
      Accept: "audio/mpeg",
      "Content-Type": "application/json",
      "xi-api-key": apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `ElevenLabs text-to-speech failed with ${response.status}${errorText ? `: ${errorText}` : ""}`,
    );
  }

  const contentType = response.headers.get("content-type") ?? "audio/mpeg";
  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    audioBase64: Buffer.from(bytes).toString("base64"),
    contentType,
    voiceId,
    modelId,
    byteLength: bytes.byteLength,
  };
}
