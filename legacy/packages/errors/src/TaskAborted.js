import { Data } from "effect";
export class TaskAborted extends Data.TaggedError("TaskAborted") {
  /** @param {{ readonly message: string, readonly details?: import("./TaggedErrorDetails.ts").TaggedErrorDetails, readonly name?: string, readonly cause?: unknown }} args */
  constructor(args) {
    super(args);
  }
}
