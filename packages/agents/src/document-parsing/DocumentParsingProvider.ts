import type { DocumentParsingResult } from "./DocumentParsingResult.ts";

export type DocumentParsingProvider = {
  name: "firecrawl" | "mistral-ocr" | "llamaparse" | string;
  parseDocument: (input: {
    source:
      | { type: "url"; url: string }
      | { type: "base64"; data: string; mimeType?: string; filename?: string }
      | { type: "text"; text: string; filename?: string };
    outputFormat?: "text" | "markdown" | "json";
    instructions?: string;
  }) => Promise<DocumentParsingResult>;
};
