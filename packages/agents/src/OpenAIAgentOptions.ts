import type { openai } from "@ai-sdk/openai";
import type { ToolSet } from "ai";
import type { SdkAgentOptions } from "./SdkAgentOptions";

type OpenAIAgentCommonOptions<
  CALL_OPTIONS,
  TOOLS extends ToolSet,
> = Omit<
  SdkAgentOptions<CALL_OPTIONS, TOOLS, ReturnType<typeof openai>>,
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
};

type OpenAIAgentPrebuiltModelOptions = {
  model: ReturnType<typeof openai>;
  baseURL?: never;
  apiKey?: never;
};

export type OpenAIAgentOptions<
  CALL_OPTIONS = never,
  TOOLS extends ToolSet = {},
> = OpenAIAgentCommonOptions<CALL_OPTIONS, TOOLS> &
  (OpenAIAgentStringModelOptions | OpenAIAgentPrebuiltModelOptions);
