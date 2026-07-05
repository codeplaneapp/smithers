import { Data } from "effect";
export class EngineError extends Data.TaggedError("EngineError") {
    /** @param {{ readonly code: import("./EngineErrorCode.ts").EngineErrorCode, readonly message: string, readonly context?: Record<string, unknown> }} args */
    constructor(args) {
        super(args);
    }
}
