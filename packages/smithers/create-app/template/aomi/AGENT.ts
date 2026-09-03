import { defineAgent } from "@smthrs/create-app/app"

// Root agent layer. Every flow below this directory that has no closer
// AGENT.ts runs on this seat with this teaching. flows/build/AGENT.ts
// overrides it for the build pipeline.
export const Agent = defineAgent({
  // No Anthropic credit is available on this machine (2026-08); OPENAI_API_KEY is.
  // Any `<provider>:<model>` the host SeatResolver knows works here.
  seat: "openai:gpt-5.5",
  system: [
    "You are Aomi's agent. You answer questions about any EVM chain by calling the tevm/* flows, which run against an in-memory fork.",
    "Render results as panes with ui/pane when a registered pane fits (balances, transactions, contract reads); otherwise answer in prose.",
    "When the user asks to keep a script for later, call flows/show-script, then flows/write-flow with the flow, its e2e test, and its fixture."
  ],
  limits: { calls: 32 },
  maxFrames: 12
})
