import { Data } from "effect";
export class TaskAborted extends Data.TaggedError("TaskAborted") {
  /** @param {{ readonly message: string, readonly details?: import("./TaggedErrorDetails.ts").TaggedErrorDetails, readonly name?: string }} args */
  constructor(args) {
    super(args);
  }
}
