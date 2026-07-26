import { Data } from "effect";
export class AgentCliError extends Data.TaggedError("AgentCliError") {
  /** @param {import("./TaggedErrorDetails.ts").GenericTaggedErrorArgs} args */
  constructor(args) {
    super(args);
  }
}
