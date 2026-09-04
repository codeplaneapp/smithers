"use server"

import { Flow } from "@smthrs/core"
import { Schema } from "effect"

export default Flow.make({
  description: "Greets whoever the caller names.",
  input: Schema.Struct({ name: Schema.String }),
  output: Schema.Struct({ greeting: Schema.String }),
  flows: ["test/echo"],
  effects: {
    reads: [],
    writes: [],
    mode: "hermetic",
    onConflict: "serialize",
    tier: "sealed"
  }
})
