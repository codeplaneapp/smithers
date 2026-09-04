/*
 * The host line of the generated instructions (docs/web-mode/PLAN.md §1).
 *
 * On the web the model is told, once, which asks belong to the native app and
 * what to execute when it gets one; on the native host the line is absent. The
 * line names `app.download.prompt`, a flow the cloud host registers — so the
 * instruction is catalog-grounded, not prompt-fragile.
 */
import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import { cloudCapabilities, localCapabilities } from "@smthrs/rpc/HostCapabilities"
import type { AgentTurnFrame, StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import type { NativeAgent, NativeRepositories } from "../native/NativeBridge"
import { createAppController } from "./AppController"
import { createAppStore } from "./AppStore"
import { NO_DOWNLOAD_LINE, smithersInstructions, WEB_HOST_LINE } from "./Instructions"
import type { InstructionHonesty } from "./Instructions"

const honesty = (host: InstructionHonesty["host"], nativeDownloadable?: boolean): InstructionHonesty => ({
  host,
  ...(nativeDownloadable === undefined ? {} : { nativeDownloadable }),
  github: { connected: false, login: null, repositories: null },
  localRepositories: [],
  localRepositoriesAvailable: host === "native"
})

describe("the host line", () => {
  test("the web app states what needs the native app, that Linear and code intelligence are among them, that the GitHub sign-in is the Cloud sign-in, and what to execute when asked", () => {
    const prompt = smithersInstructions([], honesty("web", true))
    expect(prompt).toContain(WEB_HOST_LINE)
    expect(WEB_HOST_LINE).toBe(
      "This is the Smithers web app. Local repositories, local terminals, build targets, local agents, code intelligence (hover, definitions, diagnostics) and connecting Linear need the native app; when asked for one, say so and execute app.download.prompt. On the web the GitHub sign-in is the Smithers Cloud sign-in — there is no separate Cloud sign-in to offer."
    )
    expect(prompt.split(WEB_HOST_LINE)).toHaveLength(2)
    // A published native build: no caveat.
    expect(prompt).not.toContain(NO_DOWNLOAD_LINE)
  })

  test("while no native release carries an asset the web line says the app is not downloadable, from the live fact", () => {
    for (const prompt of [smithersInstructions([], honesty("web")), smithersInstructions([], honesty("web", false))]) {
      expect(prompt).toContain(`${WEB_HOST_LINE} ${NO_DOWNLOAD_LINE}`)
      expect(prompt.split(NO_DOWNLOAD_LINE)).toHaveLength(2)
    }
    expect(smithersInstructions([], honesty("native"))).not.toContain(NO_DOWNLOAD_LINE)
  })

  test("the native app carries no such line", () => {
    expect(smithersInstructions([], honesty("native"))).not.toContain("Smithers web app")
  })
})

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const unavailableRepositories: NativeRepositories = {
  available: false,
  pickLocalRepository: async () => ({
    status: "error",
    code: "native-required",
    message: "Local repositories can only be connected from the Smithers native app."
  })
}

const settle = async (ticks = 12): Promise<void> => {
  for (let index = 0; index < ticks; index += 1) await new Promise((resolve) => setTimeout(resolve, 1))
}

/** An agent double that records the turn request and answers one text frame. */
const recordingAgent = (): { agent: NativeAgent; requests: Array<StartAgentTurnRequest> } => {
  const listeners = new Set<(frame: AgentTurnFrame) => void>()
  const requests: Array<StartAgentTurnRequest> = []
  return {
    requests,
    agent: {
      available: true,
      startTurn: async (request) => {
        requests.push(request)
        queueMicrotask(() => {
          for (const listener of listeners) {
            listener({ type: "delta", kind: "text", text: "hi", runId: request.runId } as AgentTurnFrame)
            listener({ type: "done", reason: "stop", runId: request.runId } as AgentTurnFrame)
          }
        })
        return { status: "started" }
      },
      cancelTurn: async () => {},
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    }
  }
}

const bootstrapFor = (host: AppBootstrap["host"]): AppBootstrap =>
  host === "cloud"
    ? {
      apiVersion: 1,
      host,
      version: "test",
      buildSha: "cloud",
      capabilities: cloudCapabilities({ identity: true, jjhub: true, agent: true, checkout: false, terminal: false }),
      authFlow: "redirect",
      sandbox: null
    }
    : {
      apiVersion: 1,
      host,
      version: "test",
      buildSha: "local",
      capabilities: localCapabilities({ agent: true, identity: true, jjhub: true, pathEntry: true }),
      authFlow: "native-handoff",
      sandbox: { platform: "darwin", mode: "enforced" }
    }

const firstTurnInstructions = async (host: AppBootstrap["host"]): Promise<string> => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const { agent, requests } = recordingAgent()
  const controller = createAppController(store, unavailableRepositories, agent, { bootstrap: bootstrapFor(host) })
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-in",
    login: "codeplanesmithers",
    allowlisted: true,
    admin: false,
    scopesPlain: null
  })
  await settle(2)
  controller.send("hello")
  await settle()
  expect(requests.length).toBeGreaterThan(0)
  return requests[0]?.instructions ?? ""
}

describe("the turn passes the host from the bootstrap", () => {
  test("a cloud bootstrap's turn carries the web line and the flow it names", async () => {
    const instructions = await firstTurnInstructions("cloud")
    expect(instructions).toContain(WEB_HOST_LINE)
    // The line names a flow this host's catalog actually has.
    expect(instructions).toContain("/app.download.prompt")
    // And the live download fact: no native release carries an asset today (AppLinks.ts).
    expect(instructions).toContain(NO_DOWNLOAD_LINE)
  })

  test("a local bootstrap's turn carries neither", async () => {
    const instructions = await firstTurnInstructions("local")
    expect(instructions).not.toContain("Smithers web app")
    expect(instructions).not.toContain("/app.download.prompt")
  })
})
