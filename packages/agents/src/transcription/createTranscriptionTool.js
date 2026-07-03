import { isIP } from "node:net";
import { dynamicTool, jsonSchema } from "ai";

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

  return dynamicTool({
    description:
      options.description ??
      "Transcribe speech from an audio URL or base64-encoded audio using a configured transcription provider.",
    inputSchema: jsonSchema(transcriptionInputSchema),
    execute: async (input) => {
      const request = normalizeInput(input);
      if (request.audioUrl) assertSafeAudioUrl(request.audioUrl, options);
      if (provider === "whisper") {
        return transcribeWithWhisper(options, request, fetchImpl);
      }
      if (provider === "deepgram") {
        return transcribeWithDeepgram(options, request, fetchImpl);
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
 * scheme, or a host that names loopback / private / link-local space (including
 * cloud metadata at 169.254.169.254). DNS names that are not IP literals are
 * allowed unless they name localhost. Pass `allowedAudioHosts` to pin an
 * allowlist, or `allowPrivateAudioUrl` to opt out of the guard entirely.
 *
 * @param {string} rawUrl
 * @param {import("./createTranscriptionTool.ts").CreateTranscriptionToolOptions} options
 */
function assertSafeAudioUrl(rawUrl, options) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid audioUrl: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`audioUrl must be an http(s) URL, got ${url.protocol}`);
  }
  const host = stripBrackets(url.hostname).toLowerCase();
  const allowlist = options.allowedAudioHosts;
  if (allowlist && allowlist.length > 0) {
    const allowed = allowlist.map((entry) => stripBrackets(entry).toLowerCase());
    if (!allowed.includes(host)) {
      throw new Error(`audioUrl host ${host} is not in allowedAudioHosts`);
    }
    return;
  }
  if (options.allowPrivateAudioUrl) return;
  if (isBlockedAudioHost(host)) {
    throw new Error(`Refusing to fetch audioUrl from a private, loopback, or link-local host: ${host}`);
  }
}

/**
 * @param {string} host
 * @returns {boolean}
 */
function isBlockedAudioHost(host) {
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  const kind = isIP(host);
  if (kind === 4) return isPrivateIPv4(host);
  if (kind === 6) return isPrivateIPv6(host);
  return false;
}

/**
 * @param {string} ip
 * @returns {boolean}
 */
function isPrivateIPv4(ip) {
  const parts = ip.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224) return true; // multicast + reserved 224.0.0.0/3
  return false;
}

/**
 * @param {string} ip
 * @returns {boolean}
 */
function isPrivateIPv6(ip) {
  const h = ip.toLowerCase();
  if (h === "::1" || h === "::") return true;
  const mappedDotted = h.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedDotted) return isPrivateIPv4(mappedDotted[1]);
  // URL parsing normalizes ::ffff:127.0.0.1 to its hex form ::ffff:7f00:1.
  const mappedHex = h.match(/::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = Number.parseInt(mappedHex[1], 16);
    const lo = Number.parseInt(mappedHex[2], 16);
    return isPrivateIPv4(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
  }
  const head = h.split(":")[0];
  if (/^fe[89ab]/.test(head)) return true; // fe80::/10 link-local
  if (/^f[cd]/.test(head)) return true; // fc00::/7 unique-local
  return false;
}

/**
 * @param {string} host
 * @returns {string}
 */
function stripBrackets(host) {
  return host.replace(/^\[/, "").replace(/\]$/, "");
}

/**
 * @param {import("./createTranscriptionTool.ts").CreateTranscriptionToolOptions} options
 * @param {import("./createTranscriptionTool.ts").TranscriptionToolInput} input
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<import("./createTranscriptionTool.ts").TranscriptionToolResult>}
 */
async function transcribeWithWhisper(options, input, fetchImpl) {
  const form = new FormData();
  form.set("model", options.model ?? "whisper-1");
  form.set("response_format", "verbose_json");
  if (input.language) form.set("language", input.language);
  if (input.prompt) form.set("prompt", input.prompt);

  if (input.audioBase64) {
    form.set("file", base64ToFile(input.audioBase64, input.mimeType ?? "application/octet-stream"));
  } else if (input.audioUrl) {
    const audioResponse = await fetchImpl(input.audioUrl);
    await assertOk(audioResponse, "download audio for Whisper transcription");
    const blob = await audioResponse.blob();
    form.set("file", new File([blob], filenameForMime(input.mimeType ?? blob.type), { type: input.mimeType ?? blob.type }));
  }

  const response = await fetchImpl(options.baseUrl ?? "https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${options.apiKey}` },
    body: form,
  });
  await assertOk(response, "transcribe audio with Whisper");
  const payload = /** @type {any} */ (await response.json());
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
 * @returns {Promise<import("./createTranscriptionTool.ts").TranscriptionToolResult>}
 */
async function transcribeWithDeepgram(options, input, fetchImpl) {
  const body = input.audioUrl
    ? JSON.stringify({ url: input.audioUrl })
    : Buffer.from(input.audioBase64 ?? "", "base64");
  const url = new URL(options.baseUrl ?? "https://api.deepgram.com/v1/listen");
  url.searchParams.set("model", options.model ?? "nova-3");
  url.searchParams.set("smart_format", "true");
  if (input.language) url.searchParams.set("language", input.language);

  const response = await fetchImpl(url.toString(), {
    method: "POST",
    headers: {
      Authorization: `Token ${options.apiKey}`,
      "Content-Type": input.audioUrl ? "application/json" : (input.mimeType ?? "application/octet-stream"),
    },
    body,
  });
  await assertOk(response, "transcribe audio with Deepgram");
  const payload = /** @type {any} */ (await response.json());
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
 */
async function assertOk(response, action) {
  if (response.ok) return;
  const message = await response.text().catch(() => "");
  throw new Error(`Failed to ${action}: ${response.status} ${response.statusText}${message ? ` - ${message}` : ""}`);
}

/**
 * @param {string} audioBase64
 * @param {string} mimeType
 * @returns {File}
 */
function base64ToFile(audioBase64, mimeType) {
  const bytes = Buffer.from(audioBase64, "base64");
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
