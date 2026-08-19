import type { Model } from "@flows/model/Model";
import type { ToolSet } from "./Tool";

export type SdkAgentCommonOptions<CALL_OPTIONS = never, TOOLS extends ToolSet = {}> = {
  id?: string;
  instructions?: string;
  tools?: TOOLS;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  experimental_context?: CALL_OPTIONS;
};

export type SdkAgentOptions<CALL_OPTIONS = never, TOOLS extends ToolSet = {}, MODEL = Model> = SdkAgentCommonOptions<
  CALL_OPTIONS,
  TOOLS
> &
  (
    | {
        /** Provider model id used by the configured flows route. */
        model: string;
        /** Optional wire model id override. Defaults to `model`. */
        modelId?: string;
        /** Provider API key. Defaults to the provider environment variable. */
        apiKey?: string;
      }
    | {
        /** A preconstructed flows Model implementation. */
        model: MODEL;
        /** Required because the provider-neutral Model interface intentionally has no identity field. */
        modelId: string;
        apiKey?: never;
      }
  );
