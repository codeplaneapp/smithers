/// <reference path="../smithers.d.ts" />
import { Smithers as S } from "@smthrs/targets"
import { Package as src } from "../src/PACKAGE.js"

const vocsConfig = S.file("vocs.config.ts")

const srcs = S.Filegroup({
  srcs: S.glob(["**", "!dist/**", "!.cache/**", "!pages.gen.ts"]),
})

// gen:token-lookup derives the docs token table from src/tokens.
const tokenLookup = S.Generate({
  bin: S.NodeModule.Bin("bun"),
  args: ["scripts/generateTokenLookup.ts"],
  data: [src.srcs],
  changes: ["data/tokens.ts"],
})

// The docs build consumes the declaration emit: vocs twoslash resolves
// viem imports in every snippet against the real types.
const build = S.Shell.Build({
  bin: S.NodeModule.Bin("vocs"),
  args: ["build"],
  env: { NODE_OPTIONS: "--max-old-space-size=6144" },
  data: [srcs, src.srcs, src.buildTypes, tokenLookup, vocsConfig],
  outDirs: ["dist"],
})

// Every fenced code block in the docs compiles or the target fails: the
// documentation is a type-checked artifact, not prose beside the code.
const twoslash = S.Shell.Test({
  bin: S.NodeModule.Bin("vocs"),
  args: ["twoslash"],
  data: [srcs, src.srcs, src.buildTypes, vocsConfig],
})

const dev = S.Shell.Serve({
  bin: S.NodeModule.Bin("vocs"),
  args: ["dev"],
  data: [srcs, src.srcs, src.buildTypes, tokenLookup, vocsConfig],
  readiness: { port: 5173 },
})

const preview = S.Shell.Serve({
  bin: S.NodeModule.Bin("vocs"),
  args: ["preview"],
  data: [build],
  readiness: { port: 4173 },
})

export const Package = S.Package({
  targets: { build, dev, preview, srcs, tokenLookup, twoslash },
})
