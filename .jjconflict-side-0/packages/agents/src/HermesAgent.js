import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { OpenAIAgent } from "./OpenAIAgent.js";

/**
 * @template [CALL_OPTIONS=never], [TOOLS=import("ai").ToolSet]
 * @typedef {import("./HermesAgentOptions.ts").HermesAgentOptions<CALL_OPTIONS, TOOLS>} HermesAgentOptions
 */

/**
 * Hermes (Nous Research) agent, reached over its OpenAI-compatible HTTP API.
 *
 * A thin wrapper over {@link OpenAIAgent}: it points the OpenAI-compatible
 * provider at the Hermes server (`baseURL` / `HERMES_BASE_URL`) and disables AI
 * SDK native structured output by default, since a local Hermes server may not
 * honor JSON-schema response formats. Everything else — tool loops, streaming,
 * prompt-based structured output — comes from the shared OpenAI path.
 *
 * @template [CALL_OPTIONS=never], [TOOLS=import("ai").ToolSet]
 */
export class HermesAgent extends OpenAIAgent {
  /**
   * @param {HermesAgentOptions<CALL_OPTIONS, TOOLS>} [opts]
   */
  constructor(opts = {}) {
    const {
      model = "hermes",
      baseURL = process.env.HERMES_BASE_URL,
      apiKey = process.env.HERMES_API_KEY ?? "hermes",
      nativeStructuredOutput = false,
      ...rest
    } = opts;
    if (baseURL === undefined || baseURL.trim() === "") {
      throw new SmithersError(
        "AGENT_CONFIG_INVALID",
        "HermesAgent requires a baseURL (or the HERMES_BASE_URL env var) pointing at the Hermes OpenAI-compatible API, e.g. http://127.0.0.1:5123/v1.",
        {},
      );
    }
    super({ ...rest, model, baseURL, apiKey, nativeStructuredOutput });
  }
}
