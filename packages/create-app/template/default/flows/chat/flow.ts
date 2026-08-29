/**
 * The chat flow: a question in, an answer plus cards out.
 *
 * The file's location is its name. `flows/chat/flow.ts` is the flow `chat`, its
 * seat and teaching come from the nearest ancestor AGENT.ts, and its tools come
 * from the nearest ancestor TOOLS.ts. Nothing here names a model.
 *
 * `chat: true` keeps the realm and the transcript between turns, so a follow-up
 * question runs against what the previous turn left behind.
 */
import { defineFlow } from "@smthrs/create-app/app"
import * as Schema from "effect/Schema"

export const Flow = defineFlow({
  description: "Answer a question, rendering anything worth showing as a pane.",
  payload: { message: Schema.String },
  output: Schema.Struct({
    answer: Schema.String.annotate({ description: "The prose answer; cards carry the data, so keep it short" }),
    cards: Schema.Array(Schema.String).annotate({ description: "Card ids emitted this turn, in order" })
  }),
  chat: true,
  prompt: ({ message }) => message,
  system: [
    "Render every result worth showing with ui/pane, and keep `answer` to a sentence or two saying what the card shows.",
    "Return the id of every card you emitted in `cards`, in emission order."
  ]
})
