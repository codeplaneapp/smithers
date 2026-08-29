import { Data } from "effect";
export class WorkflowFailed extends Data.TaggedError("WorkflowFailed") {
  /** @param {{ readonly message: string, readonly details?: import("./TaggedErrorDetails.ts").TaggedErrorDetails, readonly status?: number, readonly cause?: unknown }} args */
  constructor(args) {
    super(args);
  }
}
