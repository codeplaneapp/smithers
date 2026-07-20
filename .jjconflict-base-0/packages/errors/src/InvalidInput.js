import { Data } from "effect";
export class InvalidInput extends Data.TaggedError("InvalidInput") {
    /** @param {import("./TaggedErrorDetails.ts").GenericTaggedErrorArgs} args */
    constructor(args) {
        super(args);
    }
}
