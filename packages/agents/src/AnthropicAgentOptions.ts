import type { LanguageModel, ToolSet } from "ai";
import type { SdkAgentOptions } from "./SdkAgentOptions";

export type AnthropicAgentOptions<
  CALL_OPTIONS = never,
  TOOLS extends ToolSet = {},
> = SdkAgentOptions<CALL_OPTIONS, TOOLS, LanguageModel>;
