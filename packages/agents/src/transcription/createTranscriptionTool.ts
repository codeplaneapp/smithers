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
  /** Origins allowed to retain provider credentials across redirects. */
  allowedOrigins?: string[];
  /** Maximum redirect hops. Defaults to 5. */
  maxRedirects?: number;
  /** Maximum downloaded or base64-decoded audio bytes. Defaults to 25 MiB. */
  maxAudioBytes?: number;
  /** Maximum provider response bytes. Defaults to 1 MiB; must be a non-negative safe integer. */
  maxResponseBytes?: number;
  /**
   * Hosts an agent-supplied `audioUrl` may use. When set, only these hosts are
   * allowed and the localhost/non-global-literal guard is bypassed for them.
   * Use to permit an internal or special-scope audio store on purpose.
   */
  allowedAudioHosts?: string[];
  /**
   * Opt out of the SSRF guard entirely and let `audioUrl` name any http(s)
   * host, including localhost-style names, non-global literals, and hostnames
   * resolving to non-global addresses. Off by default.
   */
  allowPrivateAudioUrl?: boolean;
  /**
   * Override Node/Bun DNS resolution used to reject audio hostnames whose
   * A/AAAA answers include non-global addresses. Resolution failures are
   * denied. Useful for controlled runtimes and deterministic tests.
   */
  resolveHostname?: (hostname: string) => readonly string[] | Promise<readonly string[]>;
};

export declare function createTranscriptionTool(options: CreateTranscriptionToolOptions): Tool;
