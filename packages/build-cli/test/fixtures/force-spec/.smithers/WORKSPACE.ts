/// <reference path="../smithers.d.ts" />
import { Smithers as S } from "@smthrs/targets"
import { Package as root } from "../PACKAGE.js"
import { agents } from "./agents.js"
import { sandboxes } from "./sandbox.js"

const packageJson = S.file("//package.json")
const lockfile = S.file("//yarn.lock")

const runtime = S.Runtime.Node({ manifest: packageJson })

const packageManager = S.PackageManager.Yarn({
  manifest: packageJson,
  lockfile,
  audit: { severity: "critical", recursive: true },
})

const nodeModules = S.Npm.NodeModules({ packageJson })

const flags = S.Flags({
  production: "--production",
})

const host = S.Host({
  bins: ["aws", "hokusai", "kubectl", "detect-secrets", "detect-secrets-hook", "yalc"],
})

const memory = S.Memory.SmithersCloud({
  bank: ["repo"],
  autoInject: 5,
  init: {
    script: S.file("//scripts/init-smithers-cloud-memory.mjs"),
    secrets: [S.Secret("GITHUB_TOKEN")],
  },
})

export const Workspace = S.Workspace("force", {
  repository: "git+https://github.com/artsy/force.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime,
  packageManager,
  nodeModules,
  flags,
  host,
  memory,
  sandboxes,
  agents,
  gitHooks: {
    preCommit: root.preCommit,
    postCommit: root.postCommit,
    prePush: root.prePush,
    postMerge: root.postMerge,
  },
})
