import type { DocumentParsingProvider } from "./DocumentParsingProvider.ts";

export type DocumentParsingToolsetOptions = {
  provider?: "firecrawl" | "mistral-ocr" | "llamaparse" | DocumentParsingProvider;
  apiKey?: string;
  baseUrl?: string;
  toolName?: string;
  fetch?: typeof fetch;
};
