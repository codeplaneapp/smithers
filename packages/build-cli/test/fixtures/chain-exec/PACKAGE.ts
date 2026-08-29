import { Smithers as S } from "@smthrs/targets"

const solidity = S.Filegroup({ srcs: S.glob(["src/**", "test/**", "foundry.toml"]) })
const foundryBuild = S.Foundry.Build({ data: [solidity], outDirs: ["out"], sandbox: { network: true } })
const foundryTest = S.Foundry.Test({ data: [solidity], sandbox: { network: true } })
const foundryFmt = S.Foundry.Fmt({ data: [solidity], changes: ["src/**", "test/**"] })

const dockerBuild = S.Docker.Build({
  dockerfile: S.file("Dockerfile"),
  context: ".",
  data: [S.file("hello.txt")]
})

const dockerBake = S.Docker.Bake({ config: S.file("docker-bake.hcl"), target: "fixture" })

const dockerService = S.Docker.Serve({
  image: "alpine:3",
  command: ["sh", "-c", "touch /tmp/ready; while :; do sleep 1; done"],
  readiness: { exec: ["test", "-f", "/tmp/ready"], timeout: "60s" },
  init: [["touch", "/tmp/init-complete"]],
  stop: { signal: "SIGTERM", grace: "3s" }
})

const dockerServiceAlias = S.Docker.Service({
  image: "alpine:3",
  command: ["sh", "-c", "touch /tmp/ready; while :; do sleep 1; done"],
  readiness: { exec: ["test", "-f", "/tmp/ready"], timeout: "60s" },
  stop: { signal: "SIGTERM", grace: "3s" }
})

const dockerConsumer = S.Shell.Test({ command: "true", services: [dockerService, dockerServiceAlias] })
const dockerPush = S.Docker.Push({
  image: dockerBuild,
  registry: "registry.example.invalid",
  name: "fixture",
  tags: ["latest"],
  secrets: [S.Secret("CHAIN_DOCKER_TOKEN")],
  sandbox: { network: true },
  approval: "required"
})
const miseTool = S.Shell.Test({ bin: S.Mise.bin("mockery"), args: ["--version"] })

export const Package = S.Package({
  targets: {
    dockerBuild,
    dockerBake,
    dockerConsumer,
    dockerPush,
    dockerService,
    dockerServiceAlias,
    foundryBuild,
    foundryFmt,
    foundryTest,
    miseTool,
    solidity
  }
})
