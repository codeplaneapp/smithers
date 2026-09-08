import { readFileSync } from "node:fs"
import { expect, it } from "vitest"

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))

it.each(["README.md", "docs/installation.md"])("%s installs the platform used by its Node example", (path) => {
  const document = readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
  const install = document.match(/^pnpm add (.+)$/m)?.[1]?.split(/\s+/) ?? []

  expect(document).toContain("import * as NodeCrypto from \"@effect/platform-node/NodeCrypto\"")
  expect(install).toContain(`@effect/platform-node@${manifest.devDependencies["@effect/platform-node"]}`)
})
