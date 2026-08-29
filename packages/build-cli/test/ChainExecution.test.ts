import { spawn } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as NodeNet from "node:net"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as AnvilExec from "../src/AnvilExec.ts"
import { makeCli, normalizeArgv } from "../src/Cli.ts"
import * as DockerExec from "../src/DockerExec.ts"

const fixture = NodePath.resolve(import.meta.dirname, "fixtures/chain-exec")
const temporaryDirectories: Array<string> = []

afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

const workspace = async (): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-chain-exec-")))
  temporaryDirectories.push(root)
  await Fs.cp(fixture, root, { recursive: true })
  return root
}

const serve = async (
  root: string,
  args: ReadonlyArray<string>
): Promise<{ readonly exitCode: number; readonly output: string; readonly logs: string }> => {
  let exitCode = 0
  let output = ""
  let logs = ""
  const errWrite = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    logs += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
    return true
  }) as typeof process.stderr.write
  try {
    await makeCli({}).serve([...normalizeArgv(args), "--workspace", root], {
      exit: (code) => {
        exitCode = code
      },
      stdout: (text) => {
        output += text
      }
    })
  } finally {
    process.stderr.write = errWrite
  }
  return { exitCode, output, logs }
}

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = NodeNet.createServer()
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address === null || typeof address === "string") return reject(new Error("no port"))
      server.close(() => resolve(address.port))
    })
    server.on("error", reject)
  })

const waitForPort = async (port: number, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ready = await new Promise<boolean>((resolve) => {
      const socket = NodeNet.connect({ host: "127.0.0.1", port })
      socket.once("connect", () => {
        socket.destroy()
        resolve(true)
      })
      socket.once("error", () => resolve(false))
    })
    if (ready) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`port ${port} did not open`)
}

const portOpen = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = NodeNet.connect({ host: "127.0.0.1", port })
    socket.once("connect", () => {
      socket.destroy()
      resolve(true)
    })
    socket.once("error", () => resolve(false))
  })

describe.sequential("Foundry package execution", () => {
  it("builds and tests for real, caches both, and reports fmt drift", async () => {
    const root = await workspace()
    const built = await serve(root, ["//:foundryBuild"])
    expect(built.exitCode, built.logs).toBe(0)
    expect(built.logs).toContain("//:foundryBuild  ran")
    expect(await Fs.stat(NodePath.join(root, "out"))).toBeDefined()

    await Fs.rm(NodePath.join(root, "out"), { recursive: true, force: true })
    const restored = await serve(root, ["//:foundryBuild"])
    expect(restored.exitCode, restored.logs).toBe(0)
    expect(restored.logs).toContain("//:foundryBuild  hit")
    expect(await Fs.stat(NodePath.join(root, "out"))).toBeDefined()

    const tested = await serve(root, ["//:foundryTest"])
    expect(tested.exitCode, tested.logs).toBe(0)
    expect(tested.logs).toContain("//:foundryTest  ran")
    const testedAgain = await serve(root, ["//:foundryTest"])
    expect(testedAgain.exitCode, testedAgain.logs).toBe(0)
    expect(testedAgain.logs).toContain("//:foundryTest  hit")

    const formatted = await serve(root, ["//:foundryFmt"])
    expect(formatted.exitCode, formatted.logs).toBe(0)
    await Fs.writeFile(
      NodePath.join(root, "src/Counter.sol"),
      "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20; contract Counter{uint x;}\n",
      "utf8"
    )
    const drift = await serve(root, ["//:foundryFmt"])
    expect(drift.exitCode).toBe(1)
    expect(drift.logs).toContain("forge fmt --check")
    expect(drift.logs).toContain("Diff in src/Counter.sol")
  }, 120_000)

  it("resolves an attrs-level Foundry config relative to a nested package", async () => {
    const root = await workspace()
    await Fs.mkdir(NodePath.join(root, "contracts/src"), { recursive: true })
    await Fs.writeFile(
      NodePath.join(root, "contracts/PACKAGE.ts"),
      `import { Smithers as S } from "@smthrs/targets"
const config = S.file("foundry.toml")
const srcs = S.Filegroup({ srcs: S.glob(["src/**", "foundry.toml"]) })
const artifacts = S.Foundry.Build({ config, data: [srcs], outDirs: ["out"], sandbox: { network: true } })
export const Package = S.Package({ targets: { artifacts, srcs } })
`,
      "utf8"
    )
    await Fs.writeFile(
      NodePath.join(root, "contracts/foundry.toml"),
      "[profile.default]\nsrc = \"src\"\nout = \"out\"\nsolc = \"0.8.20\"\n",
      "utf8"
    )
    await Fs.writeFile(
      NodePath.join(root, "contracts/src/Nested.sol"),
      "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20; contract Nested {}\n",
      "utf8"
    )

    const built = await serve(root, ["//contracts:artifacts"])
    expect(built.exitCode, built.logs).toBe(0)
    expect(built.logs).toContain("//contracts:artifacts  ran")
    expect(await Fs.stat(NodePath.join(root, "contracts/out"))).toBeDefined()
  }, 120_000)
})

describe.sequential("Docker package execution", () => {
  it("builds an OCI archive through CAS and restores it on a cache hit", async () => {
    const root = await workspace()
    const built = await serve(root, ["//:dockerBuild"])
    expect(built.exitCode, built.logs).toBe(0)
    expect(built.logs).toContain("//:dockerBuild  ran")
    expect(await Fs.stat(NodePath.join(root, "docker-image/image.tar"))).toBeDefined()

    const baked = await serve(root, ["//:dockerBake"])
    expect(baked.exitCode, baked.logs).toBe(0)
    expect(baked.logs).toContain("//:dockerBake  ran")
    expect(await Fs.stat(NodePath.join(root, "docker-image-fixture/image.tar"))).toBeDefined()
    const bakedAgain = await serve(root, ["//:dockerBake"])
    expect(bakedAgain.exitCode, bakedAgain.logs).toBe(0)
    expect(bakedAgain.logs).toContain("//:dockerBake  hit")
    await Fs.rm(NodePath.join(root, "docker-image"), { recursive: true, force: true })
    const restored = await serve(root, ["//:dockerBuild"])
    expect(restored.exitCode, restored.logs).toBe(0)
    expect(restored.logs).toContain("//:dockerBuild  hit")
    expect(await Fs.stat(NodePath.join(root, "docker-image/image.tar"))).toBeDefined()
  }, 120_000)

  it("acquires, exec-probes, initializes, and releases a Docker service", async () => {
    const root = await workspace()
    const result = await serve(root, ["//:dockerConsumer"])
    expect(result.exitCode, result.logs).toBe(0)
    expect(result.logs).toContain("service //:dockerService: ready")
    expect(result.logs).toContain("service //:dockerServiceAlias: ready")
    const name = DockerExec.containerName("//:dockerService")
    const docker = await DockerExec.resolveDocker()
    expect(docker.ok).toBe(true)
    if (docker.ok) {
      const inspect = await new Promise<number>((resolve) => {
        const child = spawn(docker.path, ["inspect", name], { stdio: "ignore" })
        child.on("close", (code) => resolve(code ?? 1))
      })
      expect(inspect).not.toBe(0)
      const aliasName = DockerExec.containerName("//:dockerServiceAlias")
      const aliasInspect = await new Promise<number>((resolve) => {
        const child = spawn(docker.path, ["inspect", aliasName], { stdio: "ignore" })
        child.on("close", (code) => resolve(code ?? 1))
      })
      expect(aliasInspect).not.toBe(0)
    }
  }, 120_000)

  it("refuses an outward push before credentials or effects", async () => {
    const root = await workspace()
    const result = await serve(root, ["//:dockerPush", "--plan"])
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain("approval required")
    expect(result.output).not.toContain("NotImplemented")
  })
})

describe("host refusals and Anvil secret resolution", () => {
  it("plans a typed Mise refusal from the declared config when mise is absent", async () => {
    const root = await workspace()
    await Fs.writeFile(NodePath.join(root, "mise.toml"), "[tools]\nmockery = \"2.53.6\"\n", "utf8")
    await Fs.writeFile(
      NodePath.join(root, "WORKSPACE.ts"),
      `import { Smithers as S } from "@smthrs/targets"
const mise = S.Mise({ config: S.file("//mise.toml") })
export const Workspace = S.Workspace("mise-fixture", {
  repository: "git+https://example.invalid/mise.git",
  cache: S.Cache({ directory: ".flows" }),
  toolchains: [mise]
})
`,
      "utf8"
    )
    await Fs.writeFile(
      NodePath.join(root, "PACKAGE.ts"),
      `import { Smithers as S } from "@smthrs/targets"
const tool = S.Shell.Test({ bin: S.Mise.bin("mockery"), args: ["--version"] })
export const Package = S.Package({ targets: { tool } })
`,
      "utf8"
    )
    const result = await serve(root, ["//:tool", "--plan"])
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain("host binary")
    expect(result.output).toContain("mise")
    expect(result.output).toContain("not present on PATH")
    expect(result.output).toContain("2.53.6")
  })

  it("refuses a fork at spawn when its RPC secret has no value", async () => {
    const port = await freePort()
    const result = await AnvilExec.serviceSpec({
      label: "//:fork",
      cwd: process.cwd(),
      attrs: {
        forkUrl: { _tag: "Secret", env: "CHAIN_TEST_RPC_ABSENT" },
        forkBlockNumber: "latest",
        port
      },
      environment: {}
    })
    expect(result).toEqual({
      error: "missing secret: environment variable CHAIN_TEST_RPC_ABSENT is not set for Anvil.Fork //:fork"
    })

    const secretUrl = "https://secret.example.invalid/rpc-token"
    const resolved = await AnvilExec.serviceSpec({
      label: "//:fork",
      cwd: process.cwd(),
      attrs: {
        forkUrl: { _tag: "Secret", env: "CHAIN_TEST_RPC" },
        forkBlockNumber: 1,
        port
      },
      environment: { CHAIN_TEST_RPC: secretUrl }
    })
    expect("error" in resolved).toBe(false)
    if (!("error" in resolved)) {
      expect(resolved.argv).toContain(secretUrl)
      expect(JSON.stringify(resolved.canonicalArgv)).not.toContain(secretUrl)
      expect(JSON.stringify(resolved.canonicalArgv)).toContain("CHAIN_TEST_RPC")
    }
  })

  it("forks a local Anvil, readiness-gates a CLI consumer, and releases it", async () => {
    const tool = await AnvilExec.resolveAnvil()
    expect(tool.ok).toBe(true)
    if (!tool.ok) return
    const basePort = await freePort()
    const forkPort = await freePort()
    const base = spawn(tool.path, ["--silent", "--host", "127.0.0.1", "--port", String(basePort)], {
      stdio: "ignore"
    })
    try {
      await waitForPort(basePort)
      const root = await workspace()
      await Fs.writeFile(
        NodePath.join(root, "PACKAGE.ts"),
        `import { Smithers as S } from "@smthrs/targets"
const fork = S.Anvil.Fork({
  forkUrl: S.Secret("CHAIN_LOCAL_FORK_URL", { fallback: "http://127.0.0.1:${basePort}" }),
  forkBlockNumber: "latest",
  port: ${forkPort}
})
const consumer = S.Shell.Test({
  command: ${
          JSON.stringify(
            `curl -fsS -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' http://127.0.0.1:${forkPort} | grep -q '"result"'`
          )
        },
  services: [fork]
})
export const Package = S.Package({ targets: { consumer, fork } })
`,
        "utf8"
      )
      const result = await serve(root, ["//:consumer"])
      expect(result.exitCode, result.logs).toBe(0)
      expect(result.logs).toContain("service //:fork: ready")
      expect(await portOpen(forkPort)).toBe(false)
      const plan = await serve(root, ["//:consumer", "--plan"])
      expect(plan.output).toContain("cacheable: false")
    } finally {
      base.kill("SIGTERM")
    }
  }, 120_000)
})
