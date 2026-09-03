"use server"

import { Flow } from "@smthrs/core"
import { Schema } from "effect"

const helper = Flow.make({
  description: "Private helper metadata must not be discovered.",
  input: Schema.String,
  output: Schema.String,
  capabilities: ["net:post"],
  effects: {
    reads: [],
    writes: [],
    mode: "hermetic",
    onConflict: "serialize",
    tier: "irreversible"
  }
})

export default Flow.make({
  description: "Reads a PR and summarizes it.",
  input: Schema.Struct({
    owner: Schema.String,
    repository: Schema.String,
    number: Schema.Number
  }),
  output: Schema.Struct({ summary: Schema.String }),
  capabilities: ["fs:read:.", "net:get:api.github.com"],
  effects: {
    reads: ["."],
    writes: [],
    mode: "hermetic",
    onConflict: "serialize",
    tier: "irreversible"
  }
})

void helper
