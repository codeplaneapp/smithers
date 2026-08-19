import { dynamicTool, jsonSchema } from "./runtime-tool.js";

const DEFAULT_BASE_URL = "https://api.elevenlabs.io";
const DEFAULT_MODEL_ID = "eleven_turbo_v2_5";
const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";
const TOOL_NAME = "elevenlabs_text_to_speech";
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

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
  /** @type {string} */
  let authorizedOrigin;
  try {
    authorizedOrigin = new URL(baseUrl).origin;
  } catch {
    throw new Error(`createElevenLabsTextToSpeechTool requires an absolute baseUrl, got: ${baseUrl}`);
  }
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
            authorizedOrigin,
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
 *   authorizedOrigin: string;
 *   defaultVoiceId: string;
 *   defaultModelId: string;
 *   fetchImpl: typeof fetch;
 *   input: unknown;
 * }} params
 */
async function synthesizeSpeech({
  apiKey,
  baseUrl,
  authorizedOrigin,
  defaultVoiceId,
  defaultModelId,
  fetchImpl,
  input,
}) {
  const args = /** @type {import("./createElevenLabsTextToSpeechTool.ts").ElevenLabsTextToSpeechInput} */ (input ?? {});
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

  const response = await fetchWithGuardedRedirects({
    fetchImpl,
    apiKey,
    authorizedOrigin,
    url: `${baseUrl}/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`ElevenLabs text-to-speech failed with ${response.status}${errorText ? `: ${errorText}` : ""}`);
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

/**
 * Follow redirects manually so the xi-api-key secret is attached only to hops
 * on the authorized ElevenLabs origin. Cross-origin hops are still followed,
 * but never receive the key; every Location target is validated before use.
 *
 * @param {{
 *   fetchImpl: typeof fetch;
 *   apiKey: string;
 *   authorizedOrigin: string;
 *   url: string;
 *   body: string;
 * }} params
 * @returns {Promise<Response>}
 */
async function fetchWithGuardedRedirects({ fetchImpl, apiKey, authorizedOrigin, url, body }) {
  let currentUrl = new URL(url);
  let method = "POST";
  /** @type {string | undefined} */
  let currentBody = body;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    /** @type {Record<string, string>} */
    const headers = { Accept: "audio/mpeg" };
    if (currentBody !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (currentUrl.origin === authorizedOrigin) {
      headers["xi-api-key"] = apiKey;
    }

    const response = await fetchImpl(currentUrl.href, {
      method,
      headers,
      ...(currentBody !== undefined ? { body: currentBody } : {}),
      redirect: "manual",
    });

    if (!REDIRECT_STATUSES.has(response.status)) {
      return response;
    }

    const location = response.headers.get("location");
    if (!location) {
      return response;
    }

    const nextUrl = resolveRedirectTarget(location, currentUrl);
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
      method = "GET";
      currentBody = undefined;
    }
    currentUrl = nextUrl;
  }

  throw new Error(`ElevenLabs text-to-speech exceeded ${MAX_REDIRECTS} redirects`);
}

/**
 * @param {string} location
 * @param {URL} baseUrl
 * @returns {URL}
 */
function resolveRedirectTarget(location, baseUrl) {
  /** @type {URL} */
  let nextUrl;
  try {
    nextUrl = new URL(location, baseUrl);
  } catch {
    throw new Error(`ElevenLabs text-to-speech received an invalid redirect target: ${location}`);
  }
  if (nextUrl.protocol !== "https:" && nextUrl.protocol !== "http:") {
    throw new Error(`ElevenLabs text-to-speech refused a redirect to unsupported protocol ${nextUrl.protocol}`);
  }
  return nextUrl;
}
