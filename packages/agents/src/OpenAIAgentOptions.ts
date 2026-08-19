import type { Model } from "@flows/model/Model";
import type { SdkAgentCommonOptions } from "./SdkAgentOptions";
import type { ToolSet } from "./Tool";

type OpenAIAgentCommonOptions<CALL_OPTIONS, TOOLS extends ToolSet> = SdkAgentCommonOptions<CALL_OPTIONS, TOOLS> & {
  /**
   * Kept for source compatibility. The flows Model request has no native
   * structured-output field, so the agent always declares prompt fallback.
   */
  nativeStructuredOutput?: boolean;
};

type OpenAIAgentStringModelOptions = {
  model: string;
  /** Optional wire model id override. Defaults to `model`. */
  modelId?: string;
  /** Base URL for OpenAI Responses-compatible calls. A terminal `/v1` is accepted. */
  baseURL?: string;
  /** API key sent as a bearer token. */
  apiKey?: string;
  /** `chat` is retained only so runtime callers receive a targeted migration error. */
  api?: "responses" | "chat";
};

type OpenAIAgentPrebuiltModelOptions = {
  model: Model;
  /** Required because a provider-neutral flows Model carries no model identity. */
  modelId: string;
  baseURL?: never;
  apiKey?: never;
  api?: never;
};

export type OpenAIAgentOptions<CALL_OPTIONS = never, TOOLS extends ToolSet = {}> = OpenAIAgentCommonOptions<
  CALL_OPTIONS,
  TOOLS
> &
  (OpenAIAgentStringModelOptions | OpenAIAgentPrebuiltModelOptions);
