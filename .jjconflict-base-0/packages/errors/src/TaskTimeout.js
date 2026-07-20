import { Data } from "effect";
export class TaskTimeout extends Data.TaggedError("TaskTimeout") {
    /** @param {{ readonly message: string, readonly nodeId: string, readonly attempt: number, readonly timeoutMs: number }} args */
    constructor(args) {
        super(args);
    }
}
