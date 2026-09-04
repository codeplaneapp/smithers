import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { ProviderError } from "../src/RemoteChildProcessSpawner/ProviderError.ts"
import { defaultProviderName, selectProvider } from "../src/Sandbox/defaultProvider.ts"
import type { Provider } from "../src/Sandbox/Provider.ts"

const provider = (label: string): Provider => ({
  acquire: () => Effect.die(`unused provider ${label}`)
})

describe("selectProvider", () => {
  it("defaults to microsandbox", () => {
    expect(defaultProviderName).toBe("microsandbox")
    const microsandbox = provider("microsandbox")
    const registry = { microsandbox, directory: provider("directory") }
    expect(Effect.runSync(selectProvider(registry))).toBe(microsandbox)
    expect(Effect.runSync(selectProvider(registry, undefined))).toBe(microsandbox)
  })

  it("keeps every other provider selectable by name", () => {
    const directory = provider("directory")
    const container = provider("container")
    const registry = { microsandbox: provider("microsandbox"), directory, container }
    expect(Effect.runSync(selectProvider(registry, "directory"))).toBe(directory)
    expect(Effect.runSync(selectProvider(registry, "container"))).toBe(container)
  })

  it("refuses a missing default instead of falling back to a weaker sandbox", () => {
    const failure = Effect.runSync(Effect.flip(selectProvider({ directory: provider("directory") })))
    expect(failure).toBeInstanceOf(ProviderError)
    expect(failure.code).toBe("unavailable")
    expect(failure.message).toBe(
      "sandbox: the default provider microsandbox is not registered on this host; registered: directory"
    )
    const nothing = Effect.runSync(Effect.flip(selectProvider({})))
    expect(nothing.message).toBe(
      "sandbox: the default provider microsandbox is not registered on this host; registered: none"
    )
  })

  it("names an unregistered provider and what is registered", () => {
    const failure = Effect.runSync(
      Effect.flip(selectProvider({ microsandbox: provider("m"), aws: undefined }, "vercel"))
    )
    expect(failure.message).toBe(
      "sandbox: the provider vercel is not registered on this host; registered: microsandbox"
    )
    const empty = Effect.runSync(Effect.flip(selectProvider({}, "daytona")))
    expect(empty.message).toBe("sandbox: the provider daytona is not registered on this host; registered: none")
  })
})
