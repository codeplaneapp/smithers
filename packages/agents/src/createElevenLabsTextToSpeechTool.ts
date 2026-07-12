import type { Tool } from "ai";

export type ElevenLabsTextToSpeechInput = {
  text: string;
  voiceId?: string;
  modelId?: string;
  voiceSettings?: Record<string, unknown>;
};

export type ElevenLabsTextToSpeechResult = {
  audioBase64: string;
  contentType: string;
  voiceId: string;
  modelId: string;
  byteLength: number;
};

export type ElevenLabsTextToSpeechToolOptions = {
  apiKey: string;
  defaultVoiceId?: string;
  defaultModelId?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Exact cross-origin redirect destinations allowed to receive the request and `xi-api-key`. */
  allowedOrigins?: string[];
  /** Maximum redirect hops. Defaults to 5. */
  maxRedirects?: number;
  /** Maximum audio response bytes buffered into base64. Defaults to 25 MiB; must be a non-negative safe integer. */
  maxResponseBytes?: number;
  /** Override DNS resolution used to reject untrusted private redirect targets. */
  resolveHostname?: (hostname: string) => readonly string[] | Promise<readonly string[]>;
};

export type ElevenLabsTextToSpeechToolset = {
  tools: Record<"elevenlabs_text_to_speech", Tool>;
  toolNames: ["elevenlabs_text_to_speech"];
};

export declare function createElevenLabsTextToSpeechTool(
  options: ElevenLabsTextToSpeechToolOptions,
): ElevenLabsTextToSpeechToolset;
