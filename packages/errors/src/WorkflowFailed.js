import { Data } from "effect";
export class WorkflowFailed extends Data.TaggedError("WorkflowFailed") {
  /** @param {{ readonly message: string, readonly details?: import("./TaggedErrorDetails.ts").TaggedErrorDetails, readonly status?: number }} args */
  constructor(args) {
    super(args);
  }
}
