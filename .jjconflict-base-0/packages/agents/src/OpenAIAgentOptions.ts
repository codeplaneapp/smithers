import type { LanguageModel, ToolSet } from "ai";
import type { SdkAgentOptions } from "./SdkAgentOptions";

type OpenAIAgentCommonOptions<
  CALL_OPTIONS,
  TOOLS extends ToolSet,
> = Omit<
  SdkAgentOptions<CALL_OPTIONS, TOOLS, LanguageModel>,
  "model"
> & {
  /**
   * Disable AI SDK native structured output and let Smithers use prompt-based JSON extraction.
   * Useful for OpenAI-compatible local servers that do not honor JSON schema response formats.
   */
  nativeStructuredOutput?: boolean;
};

type OpenAIAgentStringModelOptions = {
  model: string;
  /**
   * Base URL for OpenAI-compatible API calls, e.g. a local llama.cpp server.
   */
  baseURL?: string;
  /**
   * API key sent to OpenAI-compatible endpoints. Local servers often accept "none".
   */
  apiKey?: string;
  /**
   * Which OpenAI API surface serves the string model. The provider default
   * ("responses") targets the `/responses` endpoint, which most OpenAI-compatible
   * servers (Gemini's compat layer, llama.cpp, vLLM, ...) do not implement — set
   * "chat" to call `/chat/completions` on those endpoints.
   */
  api?: "responses" | "chat";
};

type OpenAIAgentPrebuiltModelOptions = {
  model: LanguageModel;
  baseURL?: never;
  apiKey?: never;
  api?: never;
};

export type OpenAIAgentOptions<
  CALL_OPTIONS = never,
  TOOLS extends ToolSet = {},
> = OpenAIAgentCommonOptions<CALL_OPTIONS, TOOLS> &
  (OpenAIAgentStringModelOptions | OpenAIAgentPrebuiltModelOptions);
