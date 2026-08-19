export type LanguageModelUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  [key: string]: unknown;
};
export type GenerateTextResult = { text: string; output?: unknown; usage?: LanguageModelUsage; [key: string]: any };
export type StreamTextResult = Record<string, any>;
export type ModelMessage = { role: string; content: unknown; [key: string]: unknown };
