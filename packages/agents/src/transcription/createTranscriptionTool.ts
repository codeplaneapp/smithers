import type { Tool } from "ai";

export type TranscriptionProvider = "whisper" | "deepgram";

export type TranscriptionToolInput = {
  audioUrl?: string;
  audioBase64?: string;
  mimeType?: string;
  language?: string;
  prompt?: string;
};

export type TranscriptionToolResult = {
  text: string;
  language?: string;
  durationSeconds?: number;
  provider: TranscriptionProvider;
};

export type CreateTranscriptionToolOptions = {
  provider: TranscriptionProvider;
  apiKey: string;
  model?: string;
  baseUrl?: string;
  description?: string;
  fetch?: typeof fetch;
};

export declare function createTranscriptionTool(options: CreateTranscriptionToolOptions): Tool;
