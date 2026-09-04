import { expect, it } from "vitest"

it.skipIf(process.env.SMITHERS_LIVE_EXAMPLES === "1")("isolates the deterministic suite from an ambient OpenAI key", () => {
  expect(process.env.OPENAI_API_KEY ?? "").toBe("")
})
