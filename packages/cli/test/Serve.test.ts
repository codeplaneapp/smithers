/**
 * `smithers serve`, and the bind it refuses.
 *
 * The failure this guards is silent: an unauthenticated control plane on a
 * laptop's LAN address can launch agents with the operator's credentials, and
 * nothing about the running server says so.
 */
import { ControlRpcs } from "@smthrs/control"
import { describe, expect, it } from "vitest"
import * as CliError from "../src/CliError.ts"
import * as NodeControl from "../src/NodeControl.ts"
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

  it.each([
    ["127.0.0.1", true],
    ["::1", true],
    ["localhost", true],
    ["0.0.0.0", false],
    ["192.0.2.1", false]
  ] as const)("keeps every Node bind boundary in parity for %s", (host, expected) => {
    const auth = { token: "alpha-secret", principal: { id: "alpha", kind: "bearer" as const } }
    const options = { host, port: 0 }
    const boundaries = [
      () => NodeControl.layerServer(ControlRpcs.layerBearerAuth(auth), options),
      () => NodeControl.layerServerBearerAuth(auth, options),
      () => NodeControl.layerServerNoopAuth(options),
      () => NodeControl.layerGateway(Serve.health("/tmp/project"), options, "/tmp/project")
    ]

    expect(Serve.isLoopback(host)).toBe(expected)
    for (const boundary of boundaries) {
      if (expected) expect(boundary).not.toThrow()
      else expect(boundary).toThrow()
    }
  })
})

describe("the mounts", () => {
  it("names every route the gateway assembly hosts", () => {
    // `@smthrs/gateway`'s `GatewayServer.layer` mounts exactly these. The
    // banner is rendered from this list, so an entry that is not hosted cannot
    // be advertised, which is the defect the previous banner had: it printed
    // `/health` while the verb hosted the control server alone.
    expect(Serve.mounts.map((mount) => mount.path)).toEqual([
      "/rpc",
      "/rpc/ws",
      "/projections",
      "/projections/ws",
      "/sync",
      "/sync/ws",
      "/health"
    ])
    expect(Serve.mounts.filter((mount) => mount.protocol === "ws").map((mount) => mount.path)).toEqual([
      "/rpc/ws",
      "/projections/ws",
      "/sync/ws"
    ])
  })

  it("identifies the workspace by its root and nothing else", () => {
    // A supervisor asks `/health` whether the gateway it found belongs to this
    // workspace. The answer must not carry the operator's directory names.
    const identity = Serve.health("/tmp/project-one")

    expect(identity.workspaceHash).toBe(Serve.workspaceHash("/tmp/project-one/"))
    expect(identity.workspaceHash).not.toBe(Serve.workspaceHash("/tmp/project-two"))
    expect(identity.workspaceHash).not.toContain("project-one")
    expect(identity.protocolVersion).toBe("1")
  })
})

describe("the banner", () => {
  it("is rendered from the mount list, so it cannot advertise a 404", () => {
    const banner = Serve.banner(bind())

    for (const mount of Serve.mounts) {
      const base = mount.protocol === "ws" ? "ws://127.0.0.1:3000" : "http://127.0.0.1:3000"
      expect(banner).toContain(`${base}${mount.path}`)
    }
  })

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
