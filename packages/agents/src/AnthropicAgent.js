import { ModelAgent } from "./ModelAgent.js";

export class AnthropicAgent extends ModelAgent {
  /** @param {import("./AnthropicAgentOptions.ts").AnthropicAgentOptions<any, any>} opts */
  constructor(opts) {
    super(opts, "anthropic");
  }
}
