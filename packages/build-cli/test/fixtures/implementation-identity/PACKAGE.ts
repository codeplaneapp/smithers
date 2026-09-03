import { Smithers } from "@smthrs/targets"

const sources = Smithers.Filegroup({ srcs: [Smithers.file("input.txt")], cwd: "." })

const build = Smithers.ToolBuild({
  tool: "node",
  command: "node",
  args: ["-e", "require('node:fs').writeFileSync('out', 'built')"],
  inputs: [Smithers.file("input.txt")],
  outputs: ["out"],
  deps: [sources],
  env: {},
  cache: true,
  cwd: "."
})

export const Package = Smithers.Package({ targets: { build, sources } })
