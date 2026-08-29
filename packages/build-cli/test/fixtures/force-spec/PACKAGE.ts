/// <reference path="./smithers.d.ts" />
import { Smithers as S } from "@smthrs/targets"
import { Package as src } from "./src/PACKAGE.js"

const prReview = S.Agent.Lint({
  agent: S.Agents.luna,
  prompt: S.file("//.claude-review.yml"),
  data: [S.gitDiff()],
})

const detectSecrets = S.Shell.Test({
  bun: "const staged = (await $`git diff --staged --name-only`.text()).trim().split(`\\n`).filter(Boolean)\nif (staged.length) await $`${hook} --baseline .secrets.baseline ${staged}`",
  using: { hook: S.Host.bin("detect-secrets-hook") },
  data: [src.srcs, S.file(".secrets.baseline")],
})

const detectSecretsRescan = S.Shell.Test({
  bun: "await $`${detect} scan --baseline .secrets.baseline`",
  using: { detect: S.Host.bin("detect-secrets") },
  data: [src.srcs, S.file(".secrets.baseline")],
})

const detectSecretsRegen = S.Shell.Diff({
  bun: "await $`${detect} scan --exclude-files ${String.raw`src/__generated__/.*\\.ts$`} --exclude-secrets ${`(foo|secret|reset|true|toggle|trackForgotClick|passwordNextButton|hook)`} --exclude-secrets ${`^https://.*$`} --exclude-secrets ${`^onPassword.*$`} --exclude-secrets ${`[a-fA-F0-9]{24}`}`.text().then((out) => Bun.write(`.secrets.baseline`, out))\nawait $`${detect} scan --baseline .secrets.baseline`",
  using: { detect: S.Host.bin("detect-secrets") },
  data: [src.srcs],
  changes: [".secrets.baseline"],
})

const syncEnv = S.Shell.Diff({
  bin: S.Host.bin("aws"),
  args: ["s3", "cp", "s3://artsy-citadel/force/.env.shared", "./"],
  secrets: [S.Secret("AWS_ACCESS_KEY_ID"), S.Secret("AWS_SECRET_ACCESS_KEY")],
  sandbox: { network: true },
  changes: [".env.shared"],
})

// Sandboxing is the Bazel default: a target's process is confined to the
// workspace with no network unless it declares otherwise. sandbox:
// { network: true } opens the network only; sandbox: "none" is the full
// opt-out for host-coupled tools whose state lives outside the workspace
// (yalc's global store, kubeconfig, the docker daemon). The declaration is
// key material either way.
const localPaletteDev = S.Shell.Diff({
  bun: "await $`${yalc} add @artsy/palette`\nawait $`${yarn} install`",
  using: { yalc: S.Host.bin("yalc"), yarn: S.PackageManager.bin },
  changes: ["package.json", "yarn.lock", ".yalc/**"],
  sandbox: "none",
})

const localPaletteDevStop = S.Shell.Diff({
  bun: "await $`${yalc} remove @artsy/palette`\nawait $`${yarn} install`",
  using: { yalc: S.Host.bin("yalc"), yarn: S.PackageManager.bin },
  changes: ["package.json", "yarn.lock", ".yalc/**"],
  sandbox: "none",
})

const hokusai = S.Shell.Serve({
  bin: S.Host.bin("hokusai"),
  args: ["dev", "start", "--no-build"],
  sandbox: "none",
})

const deleteReviewApp = S.Shell.Run({
  bin: S.Host.bin("kubectl"),
  args: ["--context", "staging", "delete", "namespace"],
  approval: "required",
  sandbox: "none",
})

const claudeMd = S.Generate({
  emit: { "CLAUDE.md": S.symlink("AGENTS.md") },
})

const claudeConfig = S.Generate({
  script: S.file("//scripts/generate-claude.mjs"),
  data: [S.Filegroup({ srcs: S.glob(["workflows/**"]) })],
  changes: [".claude/**"],
})

const retainCommit = S.Memory.Retain({
  source: S.gitCommit("HEAD"),
  tags: ["commit"],
})

const preCommit = S.Suite({
  tests: [detectSecrets, src.lint, src.typeCheck],
})

const prePush = S.Suite({
  tests: [src.lint, src.typeCheck, src.test, src.agentLints],
})

const postMerge = S.Alias(src.relay)

const postCommit = S.Suite({
  tests: [claudeConfig, src.routesGen, retainCommit],
})

const commit = S.Git.Commit({
  gates: [preCommit],
  message: S.Agents.luna,
})

export const Package = S.Package({
  targets: {
    claudeConfig,
    claudeMd,
    commit,
    deleteReviewApp,
    detectSecrets,
    detectSecretsRegen,
    detectSecretsRescan,
    hokusai,
    localPaletteDev,
    localPaletteDevStop,
    postCommit,
    postMerge,
    preCommit,
    prePush,
    prReview,
    retainCommit,
    syncEnv,
  },
})
