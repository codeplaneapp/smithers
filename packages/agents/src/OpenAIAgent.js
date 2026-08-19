import { SmithersError } from "@smthrs/errors/SmithersError";
import { ModelAgent } from "./ModelAgent.js";

export class OpenAIAgent extends ModelAgent {
  /** @param {import("./OpenAIAgentOptions.ts").OpenAIAgentOptions<any, any>} opts */
  constructor(opts) {
    if (
      typeof opts.model !== "string" &&
      (opts.baseURL !== undefined || opts.apiKey !== undefined || opts.api !== undefined)
    ) {
      throw new SmithersError(
        "AGENT_CONFIG_INVALID",
        "OpenAIAgent baseURL/apiKey/api can only be used when model is a string.",
        {},
      );
    }
    if (opts.api === "chat") {
      throw new SmithersError(
        "AGENT_CONFIG_INVALID",
        "flows supports the OpenAI Responses protocol; chat completions are not a model seam.",
        {},
      );
    }
    super(opts, "openai");
  }
}
