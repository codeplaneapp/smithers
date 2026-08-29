import { defineAgent } from "@smthrs/create-app/app"

// The root agent layer. Every flow below this directory that has no closer
// AGENT.ts runs on this seat with this teaching. Add `flows/<id>/AGENT.ts` to
// override it for one flow and everything under it; nothing merges.
export const Agent = defineAgent({
  // Any `<provider>:<model>` the host's SeatResolver knows. No flow file names
  // a model, so this is the only place to change one.
  seat: "anthropic:claude-sonnet-4-5",
  system: [
    "You are __APP_NAME__'s agent.",
    "Call the tools in TOOLS.ts rather than answering a factual question from memory.",
    "Render a result with ui/pane whenever a registered pane fits it; otherwise answer in prose."
  ],
  limits: { calls: 16 },
  maxFrames: 8
})
