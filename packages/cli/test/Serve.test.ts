/**
 * `smithers serve`, and the bind it refuses.
 *
 * The failure this guards is silent: an unauthenticated control plane on a
 * laptop's LAN address can launch agents with the operator's credentials, and
 * nothing about the running server says so.
 */
import { describe, expect, it } from "vitest"
import * as CliError from "../src/CliError.ts"
import * as Serve from "../src/Serve.ts"

const bind = (overrides: Partial<Serve.Bind> = {}): Serve.Bind => ({
  host: "127.0.0.1",
  port: 3000,
  listen: false,
  credential: undefined,
  ...overrides
})

describe("the bind rule", () => {
  it("allows loopback with nothing else", () => {
    for (const host of Serve.loopbackHosts) {
      expect(Serve.isLoopback(host)).toBe(true)
      expect(Serve.refuse(bind({ host }))).toBeUndefined()
    }
    expect(Serve.defaultBind).toEqual({ host: "127.0.0.1", port: 3000 })
  })

  it("refuses a non-loopback bind without --listen", () => {
    const refusal = Serve.refuse(bind({ host: "0.0.0.0" }))

    expect(refusal).toBeInstanceOf(CliError.UnsupportedError)
    expect(refusal?.message).toContain("pass --listen")
    expect(CliError.exitCode(refusal!)).toBe(1)
  })

  it("refuses a non-loopback bind with --listen but no bearer token", () => {
    const refusal = Serve.refuse(bind({ host: "10.0.0.4", listen: true }))

    expect(refusal?.message).toContain("without a bearer token")
    expect(refusal?.message).toContain("SMITHERS_API_KEY")
    expect(Serve.refuse(bind({ host: "10.0.0.4", listen: true, credential: "" }))?.message)
      .toContain("without a bearer token")
  })

  it("allows a non-loopback bind that opted in and carries a token", () => {
    expect(Serve.refuse(bind({ host: "10.0.0.4", listen: true, credential: "secret" }))).toBeUndefined()
    expect(Serve.isLoopback("10.0.0.4")).toBe(false)
  })
})

describe("the banner", () => {
  it("names every mount and how the server authenticates", () => {
    const banner = Serve.banner(bind())

    expect(banner).toContain("http://127.0.0.1:3000")
    expect(banner).toContain("/rpc")
    expect(banner).toContain("ws://127.0.0.1:3000/rpc/ws")
    expect(banner).toContain("/health")
    expect(banner).toContain("none (loopback only)")
  })

  it("brackets an IPv6 host and reports bearer authentication", () => {
    const banner = Serve.banner(bind({ host: "::1", credential: "secret" }))

    expect(banner).toContain("http://[::1]:3000")
    expect(banner).toContain("bearer token")
  })
})
