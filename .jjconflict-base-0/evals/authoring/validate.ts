/**
 * Validates the SFT dataset before it is uploaded or trained on.
 *
 * The exit code is the verdict, so this runs as a `NodeTest` gate: it proves
 * every row is a well-formed OpenAI chat example before an irreversible
 * `firectl dataset create` ships it to Fireworks. It reads its dataset relative
 * to its own location, so the check is independent of the working directory the
 * runner spawns it from. It depends on nothing outside the runtime.
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const datasetPath = fileURLToPath(new URL("./data/pilot-sft.jsonl", import.meta.url))

const roles = new Set(["system", "user", "assistant", "tool"])

type Message = { role: unknown; content: unknown }

const problems: string[] = []

const text = readFileSync(datasetPath, "utf8")
const lines = text.split("\n").filter((line) => line.trim().length > 0)

if (lines.length === 0) {
  problems.push("dataset is empty")
}

lines.forEach((line, index) => {
  const row = index + 1
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch (error) {
    problems.push(`row ${row}: not valid JSON: ${(error as Error).message}`)
    return
  }

  const messages = (parsed as { messages?: unknown }).messages
  if (!Array.isArray(messages) || messages.length === 0) {
    problems.push(`row ${row}: missing a non-empty "messages" array`)
    return
  }

  messages.forEach((message: Message, messageIndex) => {
    if (typeof message.role !== "string" || !roles.has(message.role)) {
      problems.push(`row ${row}, message ${messageIndex + 1}: role ${JSON.stringify(message.role)} is not one of ${[...roles].join(", ")}`)
    }
    if (typeof message.content !== "string" || message.content.trim().length === 0) {
      problems.push(`row ${row}, message ${messageIndex + 1}: content is empty or not a string`)
    }
  })

  const last = messages[messages.length - 1] as Message
  if (last.role !== "assistant") {
    problems.push(`row ${row}: last message role is ${JSON.stringify(last.role)}, expected "assistant"`)
  }
})

if (problems.length > 0) {
  console.error(`FAIL: ${problems.length} problem(s) in ${datasetPath}`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log(`OK: ${lines.length} row(s) valid in ${datasetPath}`)
