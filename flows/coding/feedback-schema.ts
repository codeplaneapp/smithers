/** Pure private control outcome shared with the run projection. */
import { Schema } from "effect"
import { Result } from "./schema.ts"

/** Every implementation exists; pending check receipts are deliberately absent. */
export class EarlyFeedback extends Schema.TaggedError<EarlyFeedback>()("coding/EarlyFeedback", { result: Result }) {}
