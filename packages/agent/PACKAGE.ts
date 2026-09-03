/** Standard package targets plus package-owned documentation generation. */
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../PACKAGE.ts"

const { check, circular, docs, fmt, lib, lint, test } = Smithers.StandardPackage({
  packageManager,
  deps: [],
  cwd: "packages/agent"
})

const docsPages = Smithers.Generate({
  script: Smithers.file("//packages/agent/scripts/docs.mjs"),
  deps: [Smithers.Target.subtree("//packages/...", "lib")],
  data: [
    Smithers.file("//packages/agent/docs/Manifest.ts"),
    Smithers.glob("//packages/agent/src/**/*.ts"),
    Smithers.glob("//packages/agent/docs/*.md"),
    Smithers.file("//packages/agent/package.json")
  ],
  changes: ["docs/pages/api/agent.md"]
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsPages, fmt, lib, lint, test }
})
