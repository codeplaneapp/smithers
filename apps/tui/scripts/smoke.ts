import { AgentTurnFrameDecoder, applyFrame, TranscriptStore } from "../src/state/Transcript"
import { buildTurnRequest } from "../src/state/TurnRequest"

/*
 * Non-interactive smoke: a scripted fixture AgentTurnFrame stream (the exact
 * NDJSON the chat upstream emits) fed through the TUI's stream/state fold,
 * then a composer submit over the resulting transcript. Prints the resulting
 * transcript state as JSON. Run: bun run smoke
 */
const runId = "smoke-1"

const store = new TranscriptStore()

// The user turn that precedes the stream.
store.appendUserMessage(runId, "plan the tui launch")
store.setPhase("responding")

// The fixture NDJSON stream: reasoning, prose, a tool call, a plan card with
// an update, and the terminal frame — split across chunk boundaries to prove
// the line fold.
const fixtureChunks = [
  "{\"runId\":\"smoke-1\",\"type\":\"delta\",\"kind\":\"reasoning\",\"text\":\"The user wants a launch ",
  "plan.\"}\n{\"runId\":\"smoke-1\",\"type\":\"delta\",\"kind\":\"text\",\"text\":\"Here is the pla",
  "n.\"}\n{\"runId\":\"smoke-1\",\"type\":\"tool_call\",\"call_id\":\"call-1\",\"name\":\"commands\",\"arguments\":\"{\\\"action\\\":\\\"list\\\"}\"}\n",
  "{\"runId\":\"smoke-1\",\"type\":\"card\",\"card\":{\"id\":\"plan-1\",\"kind\":\"plan\",\"title\":\"TUI launch\",\"status\":\"active\",\"createdAt\":1755000000000,\"ordinal\":1,\"payload\":{\"items\":[{\"id\":\"1\",\"title\":\"scaffold\",\"status\":\"done\"},{\"id\":\"2\",\"title\":\"smoke\",\"status\":\"pending\"}]}}}\n",
  "{\"runId\":\"smoke-1\",\"type\":\"card.update\",\"id\":\"plan-1\",\"patch\":{\"status\":\"acted\"}}\n",
  "{\"runId\":\"smoke-1\",\"type\":\"done\",\"reason\":\"stop\"}\n"
]

const decoder = new AgentTurnFrameDecoder((frame) => applyFrame(store, frame))
let applied = 0
for (const chunk of fixtureChunks) applied += decoder.push(chunk)
applied += decoder.finish()
store.setPhase("idle")

// The follow-up composer submit over the settled transcript.
const submitted = buildTurnRequest("smoke-2", store.entries(), "looks good — ship step 2")

const output = {
  appliedFrames: applied,
  transcript: store.entries(),
  submit: submitted
}

console.log(JSON.stringify(output, null, 2))
