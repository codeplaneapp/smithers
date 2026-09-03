import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import type { NativeAgent, NativeRepositories } from "../native/NativeBridge"
import { createAppController } from "./AppController"
import { createAppStore } from "./AppStore"
import { composeAgentInstructions } from "@smthrs/rpc/AgentContext"
import type { AgentRuntimeContext } from "@smthrs/rpc/AgentContext"
import { CHAT_INSTRUCTIONS_CAP_BYTES, INSTRUCTIONS_BUDGET_BYTES, smithersInstructions } from "./Instructions"

/*
 * 2026-09-02: a turn failed with "Smithers Cloud chat failed (HTTP 400):
 * instructions must be a string within the size limit" — the chat seam caps
 * instructions at 16 KiB and the live catalog had grown past it. The prompt
 * now has a budget and degrades its catalog honestly instead of failing the
 * turn. This pins the budget against the REAL registry with a repository open
 * and every local capability on, the largest prompt the app builds.
 */

const CHAT_SEAM_CAP_BYTES = 16 * 1024
const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value), removeItem: (key) => void data.delete(key) }
}
const repositories: NativeRepositories = { available: true, pickLocalRepository: async () => ({ status: "cancelled" }) }
const bytes = (text: string): number => new TextEncoder().encode(text).length

describe("the instructions budget", () => {
  test("the full live registry with a repository open fits the chat seam's cap with headroom", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    store.dispatch({
      type: "repos.loaded",
      actor: "system",
      repos: [{
        id: "r1",
        path: "/Users/will/smithers",
        name: "smithersai/smithers",
        git: { branch: "main", remote: "git@github.com:smithersai/smithers.git" },
        warnings: [],
        smithers: { detected: true, workspaceFile: "WORKSPACE.ts", declarationFiles: [], reason: "1 workspace detected", workspaces: [{ path: ".", title: "smithers" }] }
      }]
    })
    let captured: { instructions?: string; context?: AgentRuntimeContext } | undefined
    const agent: NativeAgent = {
      available: true,
      startTurn: async (request) => {
        captured = request as { instructions?: string; context?: AgentRuntimeContext }
        return { status: "started" }
      },
      cancelTurn: async () => {},
      subscribe: () => () => {}
    }
    const controller = createAppController(store, repositories, agent, {
      bootstrap: {
        apiVersion: 1,
        host: "local",
        version: "0",
        buildSha: "x",
        capabilities: ["agent", "identity", "jjhub", "local.repositories", "local.repository-path-entry", "local.targets", "local.terminal", "local.harnesses", "local.lsp"],
        authFlow: "both",
        sandbox: null
      }
    })
    await controller.send("hi")
    await new Promise((resolve) => setTimeout(resolve, 50))
    const instructions = captured?.instructions ?? ""
    expect(instructions).toContain("What you can do is EXACTLY this")
    // What the seam actually measures is the COMPOSED string the Bun side sends: prompt plus the rendered runtime context.
    const composed = composeAgentInstructions(instructions, captured?.context)
    expect(bytes(composed)).toBeLessThanOrEqual(CHAT_INSTRUCTIONS_CAP_BYTES - 256)
    expect(CHAT_SEAM_CAP_BYTES).toBe(CHAT_INSTRUCTIONS_CAP_BYTES)
    expect(INSTRUCTIONS_BUDGET_BYTES).toBeLessThanOrEqual(CHAT_SEAM_CAP_BYTES - 2048)
  })

  test("a catalog too large for the budget degrades in stages and never drops a command's name", () => {
    const honesty = { github: { connected: false, login: null, repositories: null }, localRepositories: [], localRepositoriesAvailable: true } as never
    const many = Array.from({ length: 400 }, (_entry, index) => ({
      name: `ns${index % 12}.command-${index}`,
      summary: `Does the ${index}th thing, at length, so that the catalog alone outgrows the budget many times over`,
      args: "<one> [two] [three]"
    }))
    const text = smithersInstructions(many, honesty)
    expect(bytes(text)).toBeLessThanOrEqual(INSTRUCTIONS_BUDGET_BYTES + 4096)
    expect(text).toContain("Commands, by namespace")
    for (const command of many.slice(0, 20)) expect(text).toContain(`/${command.name}`)
    // A small catalog keeps every argument grammar.
    const small = smithersInstructions(many.slice(0, 5), honesty)
    expect(small).toContain("<one> [two] [three]")
  })
})
