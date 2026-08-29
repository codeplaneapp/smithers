/**
 * The chat flow: chain questions in, an answer plus cards out.
 *
 * This is the Build page's conversation. It is a chat flow, so the realm and
 * the transcript survive between turns: a follow-up question runs against the
 * fork the previous turn opened, and a script the user likes is still in the
 * turn's cell history when they ask to keep it.
 *
 * The file's location is its name. `flows/chat/flow.ts` is the flow `chat`, its
 * seat and teaching come from the root AGENT.ts, and its tools come from the
 * root TOOLS.ts. Nothing here names a model.
 */
import { defineFlow } from "@smthrs/create-app/app"
import * as Schema from "effect/Schema"

export const Flow = defineFlow({
  description: "Answer a question about any EVM chain against an in-memory fork, rendering results as panes.",
  payload: { message: Schema.String },
  output: Schema.Struct({
    answer: Schema.String.annotate({ description: "The prose answer; cards carry the data, so keep it short" }),
    cards: Schema.Array(Schema.String).annotate({ description: "Card ids emitted this turn, in order" })
  }),
  chat: true,
  prompt: ({ message }) => message,
  system: [
    "Open a fork with tevm/fork before the first chain read of a session. Later turns reuse it; do not fork again unless the user names a different chain or block.",
    "Read chain state with tevm/getBalance, tevm/readContract, tevm/call, tevm/getBlock, and tevm/simulate. Never answer a factual question about chain state from memory.",
    "Render every result you read with ui/pane. Put the numbers in the card and keep `answer` to a sentence or two that says what the card shows.",
    "Return the id of every card you emitted in `cards`, in emission order."
  ]
})
