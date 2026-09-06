import type { PlanCard, Receipt } from "@smthrs/control/ControlSchema"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const child = fileURLToPath(new URL("./fixtures/approval-content-child.ts", import.meta.url))
interface Result {
  readonly pid: number
  readonly card: PlanCard
  readonly receipt?: Receipt
  readonly error?: { readonly _tag: string; readonly message: string }
  readonly captured?: ReadonlyArray<{ readonly model: string; readonly original: boolean; readonly changed: boolean }>
}
const runChild = (action: string, root: string, cardFile?: string): Result => {
  const stdout = execFileSync(process.execPath, [child, action, root, ...cardFile === undefined ? [] : [cardFile]], {
    encoding: "utf8",
    timeout: 25_000,
    maxBuffer: 1024 * 1024
  })
  const result = stdout.split("\n").find((line) => line.startsWith("APPROVAL_CONTENT_RESULT:"))
  if (result === undefined) throw new Error(`Child returned no result: ${stdout}`)
  return JSON.parse(result.slice("APPROVAL_CONTENT_RESULT:".length)) as Result
}
const source = (body = "ORIGINAL_APPROVED_PROMPT", model = "anthropic:claude-sonnet-4-5", effort = "low") =>
  `---\ndescription: Approval content test\nmodel: ${model}\neffort: ${effort}\ncapabilities: ["model:call:**"]\n---\n${body}\n`

describe("approval binds execution across independent processes", () => {
  it.each([
    ["prompt", source("CHANGED_UNAPPROVED_PROMPT")],
    ["provider and model", source(undefined, "openai:gpt-5.6-sol")],
    ["parameters", source(undefined, undefined, "high")]
  ])("refuses an old approval after changing %s, before any provider dispatch", (_name, changed) => {
    const root = mkdtempSync(join(tmpdir(), "smithers-approved-content-"))
    try {
      const flow = join(root, "flows", "review", "flow.mdx")
      mkdirSync(join(root, "flows", "review"), { recursive: true })
      writeFileSync(flow, source())
      const first = runChild("plan", root)
      const cardFile = join(root, "approved.json")
      writeFileSync(cardFile, JSON.stringify(first.card))
      writeFileSync(flow, changed)
      const second = runChild("run", root, cardFile)
      expect(second.pid).not.toBe(first.pid)
      expect(second.card.executionDigest).not.toBe(first.card.executionDigest)
      expect(second.card.digest).not.toBe(first.card.digest)
      expect(second.error?._tag).toBe("/control/LaunchFailed")
      expect(second.receipt).toBeUndefined()
      expect(second.captured).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("executes unchanged approved bytes after the approving process exits", () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-approved-unchanged-"))
    try {
      mkdirSync(join(root, "flows", "review"), { recursive: true })
      writeFileSync(join(root, "flows", "review", "flow.mdx"), source())
      const first = runChild("plan", root)
      const cardFile = join(root, "approved.json")
      writeFileSync(cardFile, JSON.stringify(first.card))
      const second = runChild("run", root, cardFile)
      expect(second.pid).not.toBe(first.pid)
      expect(second.card.digest).toBe(first.card.digest)
      expect(second.receipt?._tag).toBe("Accepted")
      expect(second.captured).toEqual([{ model: "claude-sonnet-4-5", original: true, changed: false }])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
