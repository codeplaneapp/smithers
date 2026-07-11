import { dynamicTool, jsonSchema } from "ai";
import {
  assertHttpUrl,
  fetchWithPolicy,
  readResponseBytes,
  readResponseJson,
  readResponseText,
} from "@smithers-orchestrator/http-client";
import {
  assertPublicHostname,
  createPublicRedirectValidator,
} from "@smithers-orchestrator/http-client/node";
import { decodeBase64Bounded } from "../base64.js";
import { responseByteLimit } from "../responseByteLimit.js";

const DEFAULT_MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;

const transcriptionInputSchema = {
  type: "object",
  properties: {
    audioUrl: {
      type: "string",
      description: "HTTP(S) URL for the audio file to transcribe.",
    },
    audioBase64: {
      type: "string",
      description: "Base64-encoded audio bytes. Use this when the audio is already available in memory.",
    },
    mimeType: {
      type: "string",
      description: "MIME type for audioBase64, for example audio/mpeg or audio/wav.",
    },
    language: {
      type: "string",
      description: "Optional BCP-47 or provider-supported language hint.",
    },
    prompt: {
      type: "string",
      description: "Optional provider prompt or keywords to improve recognition.",
    },
  },
  additionalProperties: false,
};

/**
 * Create an AI SDK-compatible audio transcription tool backed by Whisper or Deepgram.
 *
 * @param {import("./createTranscriptionTool.ts").CreateTranscriptionToolOptions} options
 * @returns {import("ai").Tool}
 */
export function createTranscriptionTool(options) {
  const provider = options.provider;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("createTranscriptionTool requires fetch to be available");
  }
  const normalizedOptions = {
    ...options,
    maxAudioBytes: responseByteLimit(
      options.maxAudioBytes,
      DEFAULT_MAX_AUDIO_BYTES,
      "maxAudioBytes",
    ),
    maxResponseBytes: responseByteLimit(
      options.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
    ),
  };

  return dynamicTool({
    description:
      options.description ??
      "Transcribe speech from an audio URL or base64-encoded audio using a configured transcription provider.",
    inputSchema: jsonSchema(transcriptionInputSchema),
    execute: async (input, execution) => {
      const request = normalizeInput(input);
      if (provider === "whisper") {
        return transcribeWithWhisper(normalizedOptions, request, fetchImpl, execution?.abortSignal);
      }
      if (provider === "deepgram") {
        return transcribeWithDeepgram(normalizedOptions, request, fetchImpl, execution?.abortSignal);
      }
      throw new Error(`Unsupported transcription provider: ${provider}`);
    },
  });
}

/**
 * @param {unknown} input
 * @returns {import("./createTranscriptionTool.ts").TranscriptionToolInput}
 */
function normalizeInput(input) {
  const value = input && typeof input === "object" ? /** @type {Record<string, unknown>} */ (input) : {};
  const audioUrl = typeof value.audioUrl === "string" && value.audioUrl.trim() ? value.audioUrl.trim() : undefined;
  const audioBase64 =
    typeof value.audioBase64 === "string" && value.audioBase64.trim() ? value.audioBase64.trim() : undefined;
  if (!audioUrl && !audioBase64) {
    throw new Error("Transcription requires either audioUrl or audioBase64");
  }
  if (audioUrl && audioBase64) {
    throw new Error("Transcription accepts only one of audioUrl or audioBase64");
  }
  return {
    ...(audioUrl ? { audioUrl } : {}),
    ...(audioBase64 ? { audioBase64 } : {}),
    ...(typeof value.mimeType === "string" && value.mimeType.trim() ? { mimeType: value.mimeType.trim() } : {}),
    ...(typeof value.language === "string" && value.language.trim() ? { language: value.language.trim() } : {}),
    ...(typeof value.prompt === "string" && value.prompt.trim() ? { prompt: value.prompt.trim() } : {}),
  };
}

/**
 * Reject an agent-supplied audio URL that could drive an SSRF: a non-http(s)
 * scheme, localhost-style name, or non-global IP literal. DNS names that are
 * not IP literals are resolved and denied if any A/AAAA answer is non-global;
 * DNS rebinding remains a deployment egress concern. Pass `allowedAudioHosts` to pin an allowlist, or
 * `allowPrivateAudioUrl` to opt out of the literal/name guard entirely.
 *
 * @param {string} rawUrl
 * @param {import("./createTranscriptionTool.ts").CreateTranscriptionToolOptions} options
 * @param {AbortSignal | undefined} [signal]
 */
async function assertSafeAudioUrl(rawUrl, options, signal) {
  const url = assertHttpUrl(rawUrl);
  const host = normalizeHostname(url.hostname);
  const allowlist = options.allowedAudioHosts;
  if (allowlist && allowlist.length > 0) {
    const allowed = allowlist.map(normalizeHostname);
    if (!allowed.includes(host)) {
      throw new Error(`audioUrl host ${host} is not in allowedAudioHosts`);
    }
    return;
  }
  if (options.allowPrivateAudioUrl) return;
  await assertPublicHostname(host, {
    resolveHostname: options.resolveHostname,
    signal,
  });
}

/**
 * Normalize bracketed IPv6 and a DNS terminal root dot before host policy.
 * @param {string} host
 * @returns {string}
 */
function normalizeHostname(host) {
  return host
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .toLowerCase()
    .replace(/\.$/, "");
}

/**
 * @param {import("./createTranscriptionTool.ts").CreateTranscriptionToolOptions} options
 * @param {import("./createTranscriptionTool.ts").TranscriptionToolInput} input
 * @param {typeof fetch} fetchImpl
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<import("./createTranscriptionTool.ts").TranscriptionToolResult>}
 */
async function transcribeWithWhisper(options, input, fetchImpl, signal) {
  const maxAudioBytes = options.maxAudioBytes ?? DEFAULT_MAX_AUDIO_BYTES;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const form = new FormData();
  form.set("model", options.model ?? "whisper-1");
  form.set("response_format", "verbose_json");
  if (input.language) form.set("language", input.language);
  if (input.prompt) form.set("prompt", input.prompt);

  if (input.audioBase64) {
    form.set("file", base64ToFile(input.audioBase64, input.mimeType ?? "application/octet-stream", maxAudioBytes));
  } else if (input.audioUrl) {
    const audioResponse = await fetchWithPolicy(input.audioUrl, { signal }, {
      fetch: fetchImpl,
      maxRedirects: options.maxRedirects,
      validateUrl: (candidate) => assertSafeAudioUrl(candidate.toString(), options, signal),
    });
    await assertOk(audioResponse, "download audio for Whisper transcription", maxResponseBytes, signal);
    const audio = await readResponseBytes(audioResponse, { maxBytes: maxAudioBytes, signal });
    const contentType = input.mimeType ?? audioResponse.headers.get("content-type") ?? "application/octet-stream";
    form.set("file", new File([audio], filenameForMime(contentType), { type: contentType }));
  }

  const providerUrl = assertHttpUrl(options.baseUrl ?? "https://api.openai.com/v1/audio/transcriptions");
  const response = await fetchWithPolicy(providerUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${options.apiKey}` },
    body: form,
    signal,
  }, {
    fetch: fetchImpl,
    allowedOrigins: options.allowedOrigins,
    maxRedirects: options.maxRedirects,
    validateUrl: createPublicRedirectValidator(providerUrl, {
      allowedOrigins: options.allowedOrigins,
      resolveHostname: options.resolveHostname,
      signal,
    }),
  });
  await assertOk(response, "transcribe audio with Whisper", maxResponseBytes, signal, [options.apiKey]);
  const payload = /** @type {any} */ (await readResponseJson(response, { maxBytes: maxResponseBytes, signal }));
  return {
    text: String(payload.text ?? ""),
    ...(typeof payload.language === "string" ? { language: payload.language } : {}),
    ...(typeof payload.duration === "number" ? { durationSeconds: payload.duration } : {}),
    provider: "whisper",
  };
}

/**
 * @param {import("./createTranscriptionTool.ts").CreateTranscriptionToolOptions} options
 * @param {import("./createTranscriptionTool.ts").TranscriptionToolInput} input
 * @param {typeof fetch} fetchImpl
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<import("./createTranscriptionTool.ts").TranscriptionToolResult>}
 */
async function transcribeWithDeepgram(options, input, fetchImpl, signal) {
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const maxAudioBytes = options.maxAudioBytes ?? DEFAULT_MAX_AUDIO_BYTES;
  let audioBytes;
  let audioContentType = input.mimeType ?? "application/octet-stream";
  if (input.audioUrl) {
    const audioResponse = await fetchWithPolicy(input.audioUrl, { signal }, {
      fetch: fetchImpl,
      maxRedirects: options.maxRedirects,
      validateUrl: (candidate) => assertSafeAudioUrl(candidate.toString(), options, signal),
    });
    await assertOk(audioResponse, "download audio for Deepgram transcription", maxResponseBytes, signal);
    audioBytes = await readResponseBytes(audioResponse, { maxBytes: maxAudioBytes, signal });
    audioContentType = input.mimeType ?? audioResponse.headers.get("content-type") ?? audioContentType;
  }
  else {
    audioBytes = decodeBase64Bounded(
      input.audioBase64 ?? "",
      maxAudioBytes,
      "Transcription audio",
    );
  }
  if (audioBytes && audioBytes.byteLength > maxAudioBytes) {
    throw new Error(`Transcription audio exceeds the maximum size of ${maxAudioBytes} bytes`);
  }
  const url = assertHttpUrl(options.baseUrl ?? "https://api.deepgram.com/v1/listen");
  url.searchParams.set("model", options.model ?? "nova-3");
  url.searchParams.set("smart_format", "true");
  if (input.language) url.searchParams.set("language", input.language);

  const response = await fetchWithPolicy(url, {
    method: "POST",
    headers: {
      Authorization: `Token ${options.apiKey}`,
      "Content-Type": audioContentType,
    },
    body: audioBytes,
    signal,
  }, {
    fetch: fetchImpl,
    allowedOrigins: options.allowedOrigins,
    maxRedirects: options.maxRedirects,
    validateUrl: createPublicRedirectValidator(url, {
      allowedOrigins: options.allowedOrigins,
      resolveHostname: options.resolveHostname,
      signal,
    }),
  });
  await assertOk(response, "transcribe audio with Deepgram", maxResponseBytes, signal, [options.apiKey]);
  const payload = /** @type {any} */ (await readResponseJson(response, { maxBytes: maxResponseBytes, signal }));
  const alternative = payload.results?.channels?.[0]?.alternatives?.[0] ?? {};
  return {
    text: String(alternative.transcript ?? ""),
    ...(typeof payload.metadata?.duration === "number" ? { durationSeconds: payload.metadata.duration } : {}),
    provider: "deepgram",
  };
}

/**
 * @param {Response} response
 * @param {string} action
 * @param {number} maxResponseBytes
 * @param {AbortSignal | undefined} signal
 * @param {readonly string[]} [secrets]
 */
async function assertOk(response, action, maxResponseBytes, signal, secrets = []) {
  if (response.ok) return;
  let message = "";
  try {
    message = await readResponseText(response, {
      maxBytes: Math.min(maxResponseBytes, MAX_ERROR_BYTES),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    if (error instanceof Error && error.name === "AbortError") throw error;
  }
  let statusText = response.statusText;
  for (const secret of secrets) {
    if (!secret) continue;
    message = message.split(secret).join("[REDACTED]");
    statusText = statusText.split(secret).join("[REDACTED]");
  }
  throw new Error(`Failed to ${action}: ${response.status} ${statusText}${message ? ` - ${message}` : ""}`);
}

/**
 * @param {string} audioBase64
 * @param {string} mimeType
 * @param {number} maxBytes
 * @returns {File}
 */
function base64ToFile(audioBase64, mimeType, maxBytes) {
  const bytes = decodeBase64Bounded(audioBase64, maxBytes, "Transcription audio");
  return new File([bytes], filenameForMime(mimeType), { type: mimeType });
}

/**
 * @param {string} mimeType
 * @returns {string}
 */
function filenameForMime(mimeType) {
  const extension = mimeType.split("/")[1]?.split(";")[0] || "bin";
  return `audio.${extension}`;
}
