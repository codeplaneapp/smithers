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

export type ResolvedAudioAddress = {
  address: string;
  family?: 4 | 6;
};

export type AudioHostResolver = (
  hostname: string,
  options: { signal?: AbortSignal },
) => Promise<ResolvedAudioAddress[]> | ResolvedAudioAddress[];

export type PinnedAudioTransportRequest = {
  url: URL;
  address: string;
  family: 4 | 6;
  signal?: AbortSignal;
};

export type PinnedAudioTransport = (
  request: PinnedAudioTransportRequest,
) => Promise<Response> | Response;

export type CreateTranscriptionToolOptions = {
  provider: TranscriptionProvider;
  apiKey: string;
  model?: string;
  baseUrl?: string;
  description?: string;
  /** Provider API fetch implementation. Never used for local Whisper audio downloads. */
  fetch?: typeof fetch;
  /**
   * Maximum response-body bytes buffered from a remote audio URL before a
   * Whisper upload. Defaults to 1,048,576 bytes (1 MiB) and must be a positive
   * safe integer.
   */
  maxResponseBodyBytes?: number;
  /**
   * Maximum bytes accepted from a transcription provider response. For
   * compatibility, this also caps a remote audio URL when
   * `maxResponseBodyBytes` is omitted. Defaults to 25 MiB.
   */
  maxResponseBytes?: number;
  /**
   * Hosts an agent-supplied `audioUrl` may use. When set, only these hosts are
   * allowed and the private/loopback guard is bypassed for them. Use to permit
   * an internal audio store on purpose.
   */
  allowedAudioHosts?: string[];
  /**
   * Bypass the host/address policy and let `audioUrl` name private or loopback
   * addresses. HTTP(S) scheme checks, per-hop address pinning, redirect limits,
   * and abort handling remain enforced. Off by default.
   */
  allowPrivateAudioUrl?: boolean;
  /**
   * Trusted DNS seam for local Whisper `audioUrl` downloads. The resolver must
   * return every A and AAAA answer. Smithers validates the entire result set
   * and pins one accepted address into `audioUrlTransport`.
   */
  audioUrlResolver?: AudioHostResolver;
  /**
   * Trusted transport seam for local Whisper `audioUrl` downloads. A custom
   * transport must connect only to `request.address`, preserve the URL host for
   * HTTP Host and TLS SNI/certificate checks, disable pooling, follow no
   * redirects, and honor `request.signal`.
   */
  audioUrlTransport?: PinnedAudioTransport;
  /** Maximum local Whisper download redirects. Defaults to 5; maximum 20. */
  audioUrlMaxRedirects?: number;
};

export declare function createTranscriptionTool(options: CreateTranscriptionToolOptions): Tool;
