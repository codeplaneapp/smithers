export type DocumentParsingResult = {
  provider: "firecrawl" | "mistral-ocr" | "llamaparse" | string;
  text: string;
  markdown?: string;
  pages?: Array<{
    index: number;
    text?: string;
    markdown?: string;
    images?: unknown[];
  }>;
  metadata?: Record<string, unknown>;
  raw?: unknown;
};
