import type { Model } from "@flows/model/Model";
import type { ToolSet } from "./Tool";
import type { SdkAgentOptions } from "./SdkAgentOptions";

/**
 * Options for {@link HermesAgent}.
 *
 * Hermes (Nous Research) exposes an OpenAI-compatible HTTP API
 * (`/v1/chat/completions`), so a Hermes agent is reached the same way as any
 * OpenAI-compatible endpoint: point `baseURL` at the Hermes server. These mirror
 * the string-model form of `OpenAIAgentOptions`.
 */
export type HermesAgentOptions<CALL_OPTIONS = never, TOOLS extends ToolSet = {}> = Omit<
  SdkAgentOptions<CALL_OPTIONS, TOOLS, Model>,
  "model"
> & {
  /**
   * Model name exposed by your Hermes server. Defaults to `"hermes"`; override
   * with whatever model id the server advertises.
   */
  model?: string;
  /**
   * Base URL of the Hermes OpenAI-compatible API, e.g. `http://127.0.0.1:5123/v1`.
   * Falls back to the `HERMES_BASE_URL` environment variable.
   */
  baseURL?: string;
  /**
   * API key sent to the Hermes server. Falls back to `HERMES_API_KEY`, then
   * `"hermes"` (local servers commonly ignore the value).
   */
  apiKey?: string;
  /**
   * Enable AI SDK native structured output. Off by default because a local
   * Hermes server may not honor JSON-schema response formats — leaving it off
   * makes Smithers fall back to prompt-based JSON extraction.
   */
  nativeStructuredOutput?: boolean;
};
