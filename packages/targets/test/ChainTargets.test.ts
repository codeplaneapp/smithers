import { describe, expect, it } from "vitest"
import * as Anvil from "../src/Anvil.ts"
import * as Docker from "../src/Docker.ts"
import * as Foundry from "../src/Foundry.ts"
import * as Input from "../src/Input.ts"
import * as Mise from "../src/Mise.ts"
import * as Secret from "../src/Secret.ts"
import * as Target from "../src/Target.ts"
import * as WorkspaceDeclaration from "../src/WorkspaceDeclaration.ts"

describe("Mise and Foundry toolchain declarations", () => {
  const config = Input.file("//mise.toml")
  const mise = Mise.Mise({ config })

  it("constructs inert workspace entries and pinned tool references", () => {
    expect(mise).toEqual({ _tag: "Mise", config })
    expect(Mise.Mise.bin("mockery")).toEqual({ _tag: "MiseBin", name: "mockery" })
    expect(Foundry.Toolchain({ config: Input.file("//foundry.toml"), versions: mise })).toMatchObject({
      _tag: "FoundryToolchain",
      versions: mise
    })
  })

  it("supports a toolchains-only workspace and keeps Node declarations optional as one set", () => {
    const workspace = WorkspaceDeclaration.Workspace("chain", {
      repository: "git+https://example.invalid/chain.git",
      cache: WorkspaceDeclaration.Cache({ directory: ".flows" }),
      toolchains: [mise]
    })
    expect(workspace.toolchains).toEqual([mise])
    expect(workspace.runtime).toBeUndefined()
    expect(() =>
      WorkspaceDeclaration.Workspace("bad", {
        repository: "git+https://example.invalid/bad.git",
        cache: WorkspaceDeclaration.Cache({ directory: ".flows" }),
        runtime: { _tag: "NodeRuntimeDeclaration", version: "22" } as never
      })
    ).toThrow(/declared together/)
  })

  it("rejects unknown declaration fields", () => {
    expect(() => Mise.Mise({ config, extra: true } as never)).toThrow(/unknown option/)
    expect(() => Foundry.Toolchain({ config, version: "1" } as never)).toThrow(/unknown option/)
  })
})

describe("Foundry targets", () => {
  const srcs = Input.glob("src/**")

  it("constructs cacheable build and test rules with their declared edges and outputs", () => {
    const build = Foundry.Build({ data: [srcs], skip: ["test/**"], outDirs: ["out"] })
    const test = Foundry.Test({ data: [srcs], profile: "ci" })
    expect(Target.metadata(build)).toMatchObject({ target: "Foundry.Build", cacheable: true })
    expect(Target.metadata(build).outputs).toEqual({ cwd: ".", paths: ["out"] })
    expect(Target.metadata(build).inputs).toContainEqual(srcs)
    expect(Target.metadata(test)).toMatchObject({ target: "Foundry.Test", cacheable: true })
  })

  it("constructs forge fmt as a check/write rule and validates nested attrs strictly", () => {
    const fmt = Foundry.Fmt({ data: [srcs], changes: ["src/**"] })
    expect(Target.metadata(fmt)).toMatchObject({ target: "Foundry.Fmt", kinds: ["lint", "run"] })
    expect(() => Foundry.Build({ outDirs: ["out"], profile: "ci", typo: true } as never)).toThrow(
      /declaration.*invalid/s
    )
  })
})

describe("Anvil and Docker targets", () => {
  it("preserves an Anvil RPC fallback without reading the environment", () => {
    const url = Secret.Secret("CHAIN_RPC_URL", { fallback: "https://rpc.example.invalid" })
    const fork = Anvil.Fork({ forkUrl: url, forkBlockNumber: 1, port: 8545 })
    expect(url).toEqual({ _tag: "Secret", env: "CHAIN_RPC_URL", fallback: "https://rpc.example.invalid" })
    expect(Target.metadata(fork)).toMatchObject({ target: "Anvil.Fork", cacheable: false })
  })

  it("constructs Docker service, build, bake, and uncached push shapes", () => {
    const service = Docker.Serve({
      image: "postgres:17",
      ports: { 5432: 5432 },
      readiness: { exec: ["pg_isready"], timeout: "30s" },
      init: [["psql", "-c", "select 1"]]
    })
    const build = Docker.Build({ dockerfile: Input.file("//Dockerfile"), context: "//" })
    const bake = Docker.Bake({ config: Input.file("//docker-bake.hcl"), target: "api" })
    const push = Docker.Push({
      image: build,
      registry: "registry.example.invalid",
      name: "api",
      tags: ["latest"],
      approval: "required"
    })
    expect(Target.metadata(service).target).toBe("Docker.Serve")
    expect(Target.metadata(build)).toMatchObject({ target: "Docker.Build", cacheable: true })
    expect(Target.metadata(build).outputs).toEqual({ cwd: ".", paths: ["docker-image"] })
    expect(Target.metadata(bake).outputs).toEqual({ cwd: ".", paths: ["docker-image-api"] })
    expect(Target.metadata(push)).toMatchObject({ target: "Docker.Push", cacheable: false })
  })

  it("rejects unknown and malformed service attrs", () => {
    expect(() => Docker.Service({ image: "postgres", readiness: { exec: [], timeout: "1s" } } as never)).toThrow(
      /declaration.*invalid/s
    )
    expect(() => Docker.Build({ dockerfile: Input.file("Dockerfile"), context: ".", push: true } as never)).toThrow(
      /declaration.*invalid/s
    )
  })
})
