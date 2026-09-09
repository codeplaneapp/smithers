/** Repository flows, release workflows, and the retained migration fixtures. */
import { Smithers } from "@smthrs/targets"

const pack = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//flows/pack.test.mjs")]),
  srcs: [
    Smithers.glob("//flows/**/flow.mdx"),
    Smithers.glob("//flows/**/flow.ts"),
    Smithers.file("//.smithers/factory.json"),
    Smithers.file("//.smithers/home.json")
  ],
  deps: []
})

const cwd = "flows"
const sources = Smithers.glob("//flows/**/*.ts")
const scripts = Smithers.glob("//scripts/*.mjs")

const check = Smithers.Typecheck({
  srcs: [sources, scripts], deps: [], tsconfig: Smithers.file("tsconfig.json"),
  buildMode: false, incremental: false, cwd
})
const suite = Smithers.NodeTest({
  runner: Smithers.testRunner([
    Smithers.file("//flows/test/content.test.ts"),
    Smithers.file("//flows/test/publication.test.ts"),
    Smithers.file("//flows/test/workflows.test.ts")
  ]),
  srcs: [sources, scripts, Smithers.file("//pnpm-workspace.yaml")], deps: [], cwd
})

const recording = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//flows/test/recording.test.ts")]),
  srcs: [sources], deps: [], cwd
})
const provider = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//flows/test/provider-runtime.test.ts")]),
  srcs: [sources], deps: [], cwd
})

const coding = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//flows/test/coding.test.ts")]),
  srcs: [sources], deps: [], cwd
})
const wiki = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//flows/test/wiki.test.ts")]),
  srcs: [sources, Smithers.file("//factory/wiki/catalog.ts")], deps: [], cwd
})

export const Package = Smithers.Package({ targets: { coding, pack, check, suite, recording, provider, wiki } })
