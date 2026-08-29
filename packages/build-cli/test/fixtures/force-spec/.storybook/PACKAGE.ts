/// <reference path="../smithers.d.ts" />
import { Smithers as S } from "@smthrs/targets"
import { Package as src } from "../src/PACKAGE.js"

const storybookConfig = S.Filegroup({
  srcs: S.glob(["**"]),
})

const storiesGraph = S.ImportClosure({
  entries: S.glob(["//src/**/__stories__/**", "//src/**/*.stories.tsx"]),
})

const storybook = S.Shell.Serve({
  bin: S.NodeModule.Bin("storybook"),
  args: ["dev", "-p", "6006"],
  data: [storiesGraph, src.relayArtifacts, storybookConfig],
  // The port probe gates readiness, then repeats as the health check while
  // anything depends on the server.
  readiness: { port: 6006 },
  health: { interval: "30s" },
})

const storybookBuild = S.Shell.Build({
  bin: S.NodeModule.Bin("storybook"),
  args: ["build"],
  data: [storiesGraph, src.relayArtifacts, storybookConfig],
  outDirs: ["storybook-static"],
})

export const Package = S.Package({
  targets: { storybook, storybookBuild },
})
