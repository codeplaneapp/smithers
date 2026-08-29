/// <reference path="../smithers.d.ts" />
import { Smithers as S } from "@smthrs/targets"
import { Package as src } from "../src/PACKAGE.js"

const srcs = S.Filegroup({
  srcs: S.glob(["**", "!**/*.json"]),
})

// Cross-implementation vectors: generate.ts derives cases from independent
// oracles (@ethereumjs/rlp, micro-eth-signer, ethers). The json is a build
// artifact (gitignored upstream), so generation is a Build and the test
// replays its output against viem.
const generate = S.Shell.Build({
  bin: S.NodeModule.Bin("bun"),
  args: ["vectors/generate.ts"],
  data: [srcs, src.srcs],
  outFiles: ["**/*.json"],
})

const test = S.Shell.Test({
  bin: S.NodeModule.Bin("bun"),
  args: ["test", "vectors"],
  data: [srcs, generate, src.srcs],
})

export const Package = S.Package({
  targets: { generate, srcs, test },
})
