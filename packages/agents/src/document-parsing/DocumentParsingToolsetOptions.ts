import type { DocumentParsingProvider } from "./DocumentParsingProvider.ts";

export type DocumentParsingToolsetOptions = {
  provider?: "firecrawl" | "mistral-ocr" | "llamaparse" | DocumentParsingProvider;
  apiKey?: string;
  baseUrl?: string;
  toolName?: string;
  fetch?: typeof fetch;
  /** Origins allowed to retain provider credentials across redirects. */
  allowedOrigins?: string[];
  /** Maximum redirect hops. Defaults to 5. */
  maxRedirects?: number;
  /** Maximum provider response bytes. Defaults to 10 MiB; must be a non-negative safe integer. */
  maxResponseBytes?: number;
  /** Maximum decoded base64 or UTF-8 text input bytes. Defaults to 25 MiB. */
  maxInputBytes?: number;
  /** Override DNS resolution used to reject untrusted private redirect targets. */
  resolveHostname?: (hostname: string) => readonly string[] | Promise<readonly string[]>;
};
