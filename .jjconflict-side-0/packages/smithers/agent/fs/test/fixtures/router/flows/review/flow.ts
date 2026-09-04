import { Flow } from "@smthrs/core"
import { Schema } from "effect"

throw new Error("must not execute")

export default Flow.make({
  name: "ignored-review-name",
  description: "Review a pull request.",
  input: Schema.Struct({ number: Schema.Number })
})
