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
  /**
   * Hosts an agent-supplied `audioUrl` may use. When set, only these hosts are
   * allowed and the private/loopback guard is bypassed for them. Use to permit
   * an internal audio store on purpose.
   */
  allowedAudioHosts?: string[];
  /**
   * Opt out of the SSRF guard entirely and let `audioUrl` name any http(s)
   * host, including private/loopback addresses. Off by default.
   */
  allowPrivateAudioUrl?: boolean;
};

export declare function createTranscriptionTool(options: CreateTranscriptionToolOptions): Tool;
