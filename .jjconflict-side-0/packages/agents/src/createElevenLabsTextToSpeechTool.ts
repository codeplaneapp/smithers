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
};

export type ElevenLabsTextToSpeechToolset = {
  tools: Record<"elevenlabs_text_to_speech", Tool>;
  toolNames: ["elevenlabs_text_to_speech"];
};

export declare function createElevenLabsTextToSpeechTool(
  options: ElevenLabsTextToSpeechToolOptions,
): ElevenLabsTextToSpeechToolset;
