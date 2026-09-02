import * as Descriptor from "@smthrs/registry/Descriptor"
import { Cause, Effect, Layer, Option } from "effect"
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

const capture = () => {
  const writes: Array<string> = []
  const exits: Array<number> = []
  return {
    writes,
    exits,
    options: {
      stdout: (value: string) => writes.push(value),
      exit: (code: number) => exits.push(code)
    }
  }
}

const paths = async (cli: { readonly fetch: (request: Request) => Promise<Response> }) => {
  const spec = await (await cli.fetch(new Request("http://localhost/openapi.json"))).json() as {
    readonly paths: Readonly<Record<string, unknown>>
  }
  return Object.keys(spec.paths).sort()
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

  it("advertises a route that also has children under the reserved self segment", async () => {
    const { cli, seen } = await makeCli([makeRoute("domains"), makeRoute("domains/list")])
    expect(await paths(cli)).toEqual(["/domains/list", "/domains/self"])

    const manifest = capture()
    await cli.serve(["--llms"], manifest.options)
    expect(manifest.writes.join("")).toContain("domains self")

    const self = await cli.fetch(new Request("http://localhost/domains/self?number=3"))
    expect(self.status, await self.clone().text()).toBe(200)
    expect((await self.json()).data).toEqual({ accepted: true, number: 3 })

    const cliRun = capture()
    await cli.serve(["domains", "self", "--number", "5", "--format", "json"], cliRun.options)
    expect(cliRun.writes.join("")).toContain("5")
    expect(seen.map((invocation) => invocation.name)).toEqual(["domains", "domains"])
  })

  it("refuses a child route that claims the reserved self segment", async () => {
    const exit = await Effect.runPromise(Effect.exit(
      Incur.createCli("flows", [makeRoute("domains"), makeRoute(`domains/${Incur.selfSegment}`)]).pipe(
        Effect.provide(FlowInvoker.layerNoop())
      )
    ))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const failure = Cause.findErrorOption(exit.cause)
      expect(Option.isSome(failure) && failure.value).toMatchObject({
        code: "duplicate_route",
        path: "domains/self"
      })
    }
  })

  it("surfaces a hydration failure instead of falling back to help output", async () => {
    const unsupported = makeRoute("bad", undefined, { input: new Descriptor.SchemaRefMarkdownOutput({}) })
    const { cli, seen } = await makeCli([unsupported])

    const response = await cli.fetch(new Request("http://localhost/bad?number=1"))
    const body = await response.json()
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(body.error).toMatchObject({
      code: "unsupported_schema",
      message: "An output locator cannot describe command input"
    })

    const run = capture()
    await cli.serve(["bad", "--number", "1"], run.options)
    expect(run.writes.join("")).toContain("unsupported_schema")
    expect(run.exits).toContain(1)
    expect(seen).toEqual([])
  })

  it("reports a resolution resource limit before dispatch on both surfaces", async () => {
    const { cli, seen } = await makeCli()
    const oversized = "x".repeat(5_000)

    const response = await cli.fetch(new Request(`http://localhost/${oversized}`))
    expect(response.status).toBe(400)
    expect((await response.json()).error).toMatchObject({ code: "resource_limit" })

    const run = capture()
    await cli.serve([oversized], run.options)
    expect(run.writes.join("")).toContain("resource_limit")
    expect(run.exits).toEqual([1])
    expect(seen).toEqual([])
  })

  it("writes a pre-dispatch failure to stdout and exits when no overrides are supplied", async () => {
    const { cli } = await makeCli()
    const writes: Array<string> = []
    const write = vi.spyOn(process.stdout, "write").mockImplementation(
      ((chunk: unknown) => {
        writes.push(String(chunk))
        return true
      }) as typeof process.stdout.write
    )
    const exits: Array<number> = []
    const exit = vi.spyOn(process, "exit").mockImplementation(
      ((code: number) => {
        exits.push(code)
      }) as never
    )
    try {
      await cli.serve(["x".repeat(5_000)])
    } finally {
      write.mockRestore()
      exit.mockRestore()
    }
    expect(writes.join("")).toContain("resource_limit")
    expect(exits).toEqual([1])
  })

  it("percent-decodes and NFC-normalizes request paths", async () => {
    const composed = "caf\u00e9"
    const decomposed = "cafe\u0301"
    // The route is declared decomposed, as a macOS directory name arrives, and
    // requested composed, as a browser or an agent sends it.
    const { cli, seen } = await makeCli([makeRoute(decomposed)])

    const unicode = await cli.fetch(new Request(`http://localhost/${encodeURIComponent(composed)}?number=9`))
    expect(unicode.status, await unicode.clone().text()).toBe(200)
    expect(seen.map((invocation) => invocation.name)).toEqual([composed])

    // An encoded slash decodes inside one segment and never invents a boundary.
    expect((await cli.fetch(new Request("http://localhost/%2Fcaf%C3%A9?number=1"))).status).toBe(404)

    const malformed = await cli.fetch(new Request("http://localhost/%E0%A4%A"))
    expect(malformed.status).toBe(400)
    expect((await malformed.json()).error).toMatchObject({
      code: "parse_failed",
      message: "The request path contains a malformed percent escape"
    })
    expect(seen).toHaveLength(1)
  })

  it("treats COMPLETE as truthy exactly as incur does", async () => {
    const { cli, seen } = await makeCli()
    const previous = process.env.COMPLETE
    const empty = capture()
    const shell = capture()
    try {
      process.env.COMPLETE = ""
      await cli.serve(["review", "--number", "4", "--format", "json"], empty.options)
      process.env.COMPLETE = "zsh"
      await cli.serve(["review", "--number", "6", "--format", "json"], shell.options)
    } finally {
      if (previous === undefined) delete process.env.COMPLETE
      else process.env.COMPLETE = previous
    }
    expect(empty.writes.join("")).toContain("4")
    expect(shell.writes.join("")).not.toContain("6")
    expect(seen.map((invocation) => invocation.input)).toEqual([{ number: 4 }])
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
