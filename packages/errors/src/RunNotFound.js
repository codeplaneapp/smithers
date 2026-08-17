import { Data } from "effect";
export class RunNotFound extends Data.TaggedError("RunNotFound") {
  /** @param {{ readonly message: string, readonly runId: string, readonly cause?: unknown }} args */
  constructor(args) {
    super(args);
  }
}
