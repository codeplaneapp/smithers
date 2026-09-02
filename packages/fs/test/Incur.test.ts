import { Effect, Layer } from "effect"
import { describe, expect, it, vi } from "vitest"
import * as FlowInvoker from "../src/FlowInvoker.ts"
import * as Incur from "../src/Incur.ts"
import { makeRoute } from "./helpers.ts"

const makeCli = async (routes = [makeRoute("review")]) => {
  const seen: Array<FlowInvoker.Invocation> = []
  const invoker = FlowInvoker.make({
    invoke: (invocation) =>
      Effect.sync(() => {
        seen.push(invocation)
        const number = (invocation.input as { readonly number: number }).number
        return { accepted: true, number }
      })
  })
  const cli = await Effect.runPromise(
    Incur.createCli("flows", routes).pipe(Effect.provide(Layer.succeed(FlowInvoker.FlowInvoker, invoker)))
  )
  return { cli, seen }
}

describe("Incur projection", () => {
  it("carries typed inputs consistently over GET and JSON POST", async () => {
    const { cli, seen } = await makeCli()
    const get = await cli.fetch(new Request("http://localhost/review?number=42&enabled=true"))
    const post = await cli.fetch(
      new Request("http://localhost/review", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ number: 43, tags: ["a", "b"] })
      })
    )

    expect(get.status).toBe(200)
    expect((await get.json()).data).toEqual({ accepted: true, number: 42 })
    expect(post.status).toBe(200)
    expect((await post.json()).data).toEqual({ accepted: true, number: 43 })
    expect(seen.map((invocation) => invocation.input)).toEqual([
      { number: 42, enabled: true },
      { number: 43, tags: ["a", "b"] }
    ])
  })

  it("accepts declared flags from the CLI projection", async () => {
    const { cli, seen } = await makeCli()
    const writes: Array<string> = []
    const write = vi.spyOn(process.stdout, "write").mockImplementation(
      ((chunk: unknown) => {
        writes.push(String(chunk))
        return true
      }) as typeof process.stdout.write
    )
    try {
      await cli.serve(["review", "--number", "44", "--format", "json"])
    } finally {
      write.mockRestore()
    }
    expect(seen[0]?.input).toEqual({ number: 44 })
    expect(writes.join("")).toContain("44")
  })

  it("keeps parent routes and nested routes independently executable", async () => {
    const { cli, seen } = await makeCli([makeRoute("domains"), makeRoute("domains/list")])
    expect((await cli.fetch(new Request("http://localhost/domains?number=1"))).status).toBe(200)
    const nested = await cli.fetch(new Request("http://localhost/domains/list?number=2"))
    expect(nested.status, await nested.clone().text()).toBe(200)
    expect(seen.map((invocation) => invocation.name)).toEqual(["domains", "domains/list"])
  })

  it("accepts slash names and metadata-only groups through the CLI", async () => {
    const { cli, seen } = await makeCli([makeRoute("nested/visible"), makeRoute("domains/list")])
    const writes: Array<string> = []
    await cli.serve(["nested/visible", "--number", "7", "--format", "json"], {
      stdout: (value) => writes.push(value),
      exit: () => undefined
    })
    expect(seen.map((entry) => entry.name)).toEqual(["nested/visible"])
    expect(writes.join("")).toContain("7")
    expect((await cli.fetch(new Request("http://localhost/openapi.json"))).status).toBe(200)
  })

  it("keeps CLI discovery and unknown commands metadata-only", async () => {
    const { cli, seen } = await makeCli()
    const writes: Array<string> = []
    const exits: Array<number> = []
    const options = {
      stdout: (value: string) => writes.push(value),
      exit: (code: number) => exits.push(code)
    }
    await cli.serve(["--help"], options)
    await cli.serve(["missing"], options)
    expect(writes.join("")).toContain("review")
    expect(exits).toContain(1)
    expect(seen).toEqual([])
  })

  it("never mounts hidden or unsupported routes", async () => {
    const { cli } = await makeCli([
      makeRoute("visible"),
      makeRoute("hidden", undefined, { modelInvocable: false }),
      makeRoute("markdown", undefined, { kind: "markdown" }),
      makeRoute("skill", undefined, { kind: "skill" })
    ])
    for (const name of ["hidden", "markdown", "skill"]) {
      expect((await cli.fetch(new Request(`http://localhost/${name}?number=1`))).status).toBe(404)
    }
    const spec = await cli.fetch(new Request("http://localhost/openapi.json"))
    expect(spec.status).toBe(200)
    expect(await spec.text()).not.toContain("hidden")
  })

  it("returns a stable typed refusal for invalid route input", async () => {
    const { cli, seen } = await makeCli()
    const response = await cli.fetch(new Request("http://localhost/review?number=not-a-number"))
    const body = await response.json()
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(body.error).toMatchObject({ code: "decode_failed" })
    expect(JSON.stringify(body)).not.toContain("not-a-number")
    expect(seen).toEqual([])
  })
})
