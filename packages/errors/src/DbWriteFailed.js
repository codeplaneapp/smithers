import { Data } from "effect";
export class DbWriteFailed extends Data.TaggedError("DbWriteFailed") {
  /** @param {import("./TaggedErrorDetails.ts").GenericTaggedErrorArgs} args */
  constructor(args) {
    super(args);
  }
}
