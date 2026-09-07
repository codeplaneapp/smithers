import { describe, expect, test } from "bun:test"
import { cloudRole } from "@smthrs/rpc/AgentRoles"
import {
  CLOUD_ROLE_MAX_TOKENS,
  cloudRoleMessages,
  cloudRoleModel,
  handleCloudRoleTurn,
  isCloudRoleTurn,
  turnHints
} from "./cloudRoleTurn"
import type { TurnRequest } from "./cloudRoleTurn"
import type { FetchLike } from "./recommend"

const body: TurnRequest = {
  runId: "run-lib-1",
  messages: [{ role: "user", content: "Where are triggers registered?" }],
  instructions: "You are the Librarian.",
  role: "librarian",
  purpose: "librarian"
}

const completion = (content: string, model = "gpt-oss-120b"): Response =>
  Response.json({ model, choices: [{ message: { content } }] })

const recording = (
  answer: (request: Request) => Response | Promise<Response>
): { readonly fetchImpl: FetchLike; readonly calls: Array<Request> } => {
  const calls: Array<Request> = []
  return {
    calls,
    fetchImpl: async (input, init) => {
      const request = new Request(input, init)
      calls.push(request)
      return answer(request)
    }
  }
}

describe("the turn hints", () => {
  test("keeps the two tiers, a purpose under 200 characters and a role id under 40; drops everything else silently", () => {
    expect(turnHints({ tier: "cheap", purpose: "recommend", role: "explainer" })).toEqual({
      tier: "cheap",
      purpose: "recommend",
      role: "explainer"
    })
    expect(turnHints({})).toEqual({})
    expect(turnHints({ tier: "gold", purpose: 7, role: ["librarian"] })).toEqual({})
    expect(turnHints({ purpose: "x".repeat(201) })).toEqual({})
    expect(turnHints({ purpose: "x".repeat(200) })).toEqual({ purpose: "x".repeat(200) })
    expect(turnHints({ role: `l${"o".repeat(40)}` })).toEqual({})
    expect(turnHints({ role: "Librarian" })).toEqual({})
    expect(turnHints({ role: "--model" })).toEqual({})
    expect(turnHints({ role: "librarian", purpose: "" })).toEqual({ role: "librarian" })
  })

  test("a cloud role turn is exactly a body whose role is a cloud role id", () => {
    expect(isCloudRoleTurn(body)).toBe(true)
    expect(isCloudRoleTurn({ ...body, role: "flows" })).toBe(true)
    expect(isCloudRoleTurn({ ...body, role: "explainer" })).toBe(false)
    expect(isCloudRoleTurn({ ...body, role: undefined })).toBe(false)
  })
})

describe("the cloud role messages", () => {
  test("renders the composed instructions as the system message and the transcript after it", () => {
    const messages = cloudRoleMessages({
      ...body,
      messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }, { role: "user", content: "again" }]
    })
    expect(messages).toEqual([
      { role: "system", content: "You are the Librarian." },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "again" }
    ])
  })

  test("a tool-loop continuation item has no rendering: the cloud role cannot continue a call", () => {
    expect(cloudRoleMessages({
      ...body,
      messages: [
        { role: "user", content: "run it" },
        { type: "function_call", call_id: "c1", name: "commands", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: "done" }
      ]
    })).toBeUndefined()
  })

  test("the served model is the table default, or the role's env override", () => {
    expect(cloudRoleModel(cloudRole("librarian"), {})).toBe("gpt-oss-120b")
    expect(cloudRoleModel(cloudRole("flows"), {})).toBe("qwen-3.8-27b")
    expect(cloudRoleModel(cloudRole("flows"), { CEREBRAS_MODEL_FLOWS: "gemma-4-31b" })).toBe("gemma-4-31b")
    expect(cloudRoleModel(cloudRole("librarian"), { CEREBRAS_MODEL_FLOWS: "gemma-4-31b" })).toBe("gpt-oss-120b")
  })
})

describe("serving a cloud role turn", () => {
  const headers = { "x-test": "1" }

  test("one completion becomes one text delta and a done frame tagged with the body's runId, on the role's model", async () => {
    const network = recording(() => completion("Triggers are registered in flows/triggers.ts."))
    const response = await handleCloudRoleTurn(body, { CEREBRAS_API_KEY: "csk-test" }, headers, undefined, network.fetchImpl)
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("application/x-ndjson")
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("x-test")).toBe("1")
    const frames = (await response.text()).trim().split("\n").map((line) => JSON.parse(line))
    expect(frames).toEqual([
      { runId: "run-lib-1", type: "delta", kind: "text", text: "Triggers are registered in flows/triggers.ts." },
      { runId: "run-lib-1", type: "done", reason: "stop" }
    ])
    expect(network.calls.length).toBe(1)
    expect(network.calls[0]!.url).toBe("https://api.cerebras.ai/v1/chat/completions")
    expect(network.calls[0]!.headers.get("authorization")).toBe("Bearer csk-test")
    const sent = (await network.calls[0]!.json()) as {
      model: string
      max_tokens: number
      messages: Array<{ role: string; content: string }>
      response_format?: unknown
      tools?: unknown
    }
    expect(sent.model).toBe("gpt-oss-120b")
    expect(sent.max_tokens).toBe(CLOUD_ROLE_MAX_TOKENS)
    expect(sent.response_format).toBeUndefined()
    expect(sent.tools).toBeUndefined()
    expect(sent.messages[0]).toEqual({ role: "system", content: "You are the Librarian." })
  })

  test("the flows role reads its own model, and the env override wins", async () => {
    const network = recording(() => completion("Run /review."))
    const response = await handleCloudRoleTurn(
      { ...body, role: "flows", purpose: "flows" },
      { CEREBRAS_API_KEY: "csk-test", CEREBRAS_MODEL_FLOWS: "gemma-4-31b" },
      headers,
      undefined,
      network.fetchImpl
    )
    expect(response.status).toBe(200)
    await response.text()
    expect(((await network.calls[0]!.json()) as { model: string }).model).toBe("gemma-4-31b")
  })

  test("a tool-bearing body is refused with 400 before any provider byte is spent", async () => {
    const network = recording(() => completion("never"))
    const tools = [{ type: "function" as const, name: "commands", description: "the one tool", parameters: {} }]
    const response = await handleCloudRoleTurn({ ...body, tools }, { CEREBRAS_API_KEY: "csk-test" }, headers, undefined, network.fetchImpl)
    expect(response.status).toBe(400)
    expect(((await response.json()) as { message: string }).message).toContain("runs no tools")
    expect(network.calls.length).toBe(0)
  })

  test("a tool-loop continuation is refused with 400 too", async () => {
    const network = recording(() => completion("never"))
    const response = await handleCloudRoleTurn({
      ...body,
      messages: [{ type: "function_call_output", call_id: "c1", output: "done" }]
    }, { CEREBRAS_API_KEY: "csk-test" }, headers, undefined, network.fetchImpl)
    expect(response.status).toBe(400)
    expect(network.calls.length).toBe(0)
  })

  test("an empty tools list is not a tool-bearing body", async () => {
    const network = recording(() => completion("ok"))
    const response = await handleCloudRoleTurn({ ...body, tools: [] }, { CEREBRAS_API_KEY: "csk-test" }, headers, undefined, network.fetchImpl)
    expect(response.status).toBe(200)
    await response.text()
    expect(network.calls.length).toBe(1)
  })

  test("no key is an honest 503 naming the variable, never a provider call", async () => {
    const network = recording(() => completion("never"))
    const response = await handleCloudRoleTurn(body, {}, headers, undefined, network.fetchImpl)
    expect(response.status).toBe(503)
    expect(((await response.json()) as { message: string }).message).toContain("CEREBRAS_API_KEY is unset")
    expect(network.calls.length).toBe(0)
  })

  test("a provider limit stays 429, another provider failure is 502, and neither leaks the provider's body", async () => {
    const limited = recording(() => new Response("{\"error\":\"slow down\"}", { status: 429 }))
    const refused = await handleCloudRoleTurn(body, { CEREBRAS_API_KEY: "csk-test" }, headers, undefined, limited.fetchImpl)
    expect(refused.status).toBe(429)
    expect(((await refused.json()) as { message: string }).message).toBe("The Librarian's model service answered HTTP 429.")

    const broken = recording(() => new Response("<html>oops</html>", { status: 500 }))
    const failed = await handleCloudRoleTurn(body, { CEREBRAS_API_KEY: "csk-test" }, headers, undefined, broken.fetchImpl)
    expect(failed.status).toBe(502)
    expect(((await failed.json()) as { message: string }).message).not.toContain("oops")

    const unreachable = recording(() => {
      throw new TypeError("fetch failed")
    })
    const down = await handleCloudRoleTurn(body, { CEREBRAS_API_KEY: "csk-test" }, headers, undefined, unreachable.fetchImpl)
    expect(down.status).toBe(502)
    expect(((await down.json()) as { message: string }).message).toContain("unreachable")
  })

  test("a completion with no text is a done frame that says so, not a silent empty stream", async () => {
    const network = recording(() => completion("   "))
    const response = await handleCloudRoleTurn(body, { CEREBRAS_API_KEY: "csk-test" }, headers, undefined, network.fetchImpl)
    expect(response.status).toBe(200)
    const frames = (await response.text()).trim().split("\n").map((line) => JSON.parse(line))
    expect(frames).toEqual([{ runId: "run-lib-1", type: "done", reason: "stop", error: "The Librarian answered with no text." }])
  })

  test("the client leaving aborts the provider call and answers 499", async () => {
    const controller = new AbortController()
    const network = recording((request) =>
      new Promise<Response>((_, reject) => {
        request.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
        controller.abort()
      }))
    const response = await handleCloudRoleTurn(body, { CEREBRAS_API_KEY: "csk-test" }, headers, controller.signal, network.fetchImpl)
    expect(response.status).toBe(499)
  })
})
