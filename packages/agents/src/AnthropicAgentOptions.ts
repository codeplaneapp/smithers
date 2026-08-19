import type { Model } from "@flows/model/Model";
import type { ToolSet } from "./Tool";
import type { SdkAgentOptions } from "./SdkAgentOptions";

export type AnthropicAgentOptions<CALL_OPTIONS = never, TOOLS extends ToolSet = {}> = SdkAgentOptions<
  CALL_OPTIONS,
  TOOLS,
  Model
>;
