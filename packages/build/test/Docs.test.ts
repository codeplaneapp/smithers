/**
 * The gate this package's prose never had.
 *
 * `standard.docs` resolves to `DocsParity`, which checks that a README exists
 * and carries prose. Nothing owned the other seven prose surfaces, so they
 * drifted: five pages described an install flow that had stopped trampolining,
 * a deploy recipe exported a variable nothing read, a trust model claimed a
 * credential split one deployment did not have, and two tables listed managers
 * no declaration can name.
 *
 * Every assertion here reads the claim out of the code it describes, so a
 * source change moves the gate rather than a reviewer's memory of it. Prose
 * that no invariant can be derived from stays outside this file.
 */
import * as Fs from "node:fs"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as Install from "../src/Install.ts"
import * as PackageManager from "../src/PackageManager.ts"

const packageRoot = NodePath.join(import.meta.dirname, "..")

const read = (relative: string): string => Fs.readFileSync(NodePath.join(packageRoot, relative), "utf8")

/** Every markdown surface this package publishes, `dist/` excluded. */
const proseFiles = (): ReadonlyArray<string> => {
  const found: Array<string> = []
  const walk = (relative: string): void => {
    for (const entry of Fs.readdirSync(NodePath.join(packageRoot, relative), { withFileTypes: true })) {
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`
      if (entry.isDirectory()) {
        if (["dist", "node_modules", "terraform"].includes(entry.name)) continue
        walk(path)
        continue
      }
      if (entry.name.endsWith(".md")) found.push(path)
    }
  }
  walk("")
  return found
}

/** The first column of every row of one pipe table, by its heading. */
const tableColumn = (markdown: string, heading: string): ReadonlyArray<string> => {
  const lines = markdown.split("\n")
  const start = lines.findIndex((line) => line.trim().toLowerCase().endsWith(heading.toLowerCase()))
  expect(start, `no heading ending in "${heading}"`).toBeGreaterThanOrEqual(0)
  const rows: Array<string> = []
  let seenHeader = false
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith("|")) {
      if (rows.length > 0 || seenHeader) break
      continue
    }
    const first = line.split("|")[1]?.trim() ?? ""
    if (first.startsWith("-") || first === "Manager") {
      seenHeader = true
      continue
    }
    rows.push(first)
  }
  return rows
}

describe("packages/build prose", () => {
  it("names only managers a declaration can select", () => {
    const declarable = new Set(PackageManager.Name.literals.map((name) => name.toLowerCase()))
    expect(declarable).toEqual(new Set(["pnpm", "bun"]))
    for (const [file, heading] of [["DESIGN.md", "Manager support"], ["docs/concepts/install.md", "Manager support"]]) {
      const managers = tableColumn(read(file!), heading!)
      expect(managers.length).toBeGreaterThan(0)
      for (const manager of managers) {
        expect(declarable, `${file} lists ${manager} as a selectable manager`).toContain(manager.toLowerCase())
      }
    }
  })

  it("describes the install flow with the number of rounds it runs", () => {
    expect(Install.Install.maxRounds).toBe(1)
    // A page may say the flow used to trampoline: that history is why the
    // measure result is an ordinary settled reference. What it may not do is
    // describe a second round in the present tense.
    const history = /\bused to\b|\bno longer\b|\bonce\b|\bstopped\b/i
    for (const file of proseFiles()) {
      for (const line of read(file).split("\n")) {
        if (!/\btwo[- ]rounds?\b|two trampoline rounds|second trampoline round/i.test(line)) continue
        expect(line, `${file} describes a round the flow no longer runs`).toMatch(history)
      }
    }
  })

  it("keeps the deploy recipe on the variable names the deployment reads", () => {
    // The verifier pair moved from `alchemy.run.ts` into `deployment.ts`, so
    // the names are read where `cacheCredentialVerifiers` declares them.
    const deployment = read("infra/deployment.ts")
    const names = [...deployment.matchAll(/cacheTokenVerifier\("([A-Z_]+)"\)/g)].map((match) => match[1]!)
    expect(names).toEqual(["SMITHERS_CACHE_READ_TOKEN", "SMITHERS_CACHE_WRITE_TOKEN"])
    const page = read("docs/workspace/remote-caching.md")
    for (const name of names) expect(page, `remote-caching.md never names ${name}`).toContain(name)
  })

  it("states the credential split both deployments enforce", () => {
    // Both implementations refuse two equal digests, so no page may still
    // describe the self-hosted tier as single-credential or offer one secret
    // for both directions as a rollout step.
    expect(read("terraform/modules/cache/service/config.js")).toContain("SMITHERS_CACHE_READ_TOKEN")
    expect(read("infra/CACHE-TRUST.md")).not.toMatch(/still\s+has one credential/i)
    for (const file of proseFiles()) {
      expect(read(file), `${file} still offers one secret for both directions`).not.toMatch(
        /set \*\*both to the current/i
      )
    }
  })

  it("documents every command the CLI registers", () => {
    // The CLI reference restated `@smthrs/build-cli`'s command surface and
    // then drifted: three commands shipped with no row here. The inventory is
    // read out of the registration calls, so a new command moves this gate.
    const source = read("../build-cli/src/Cli.ts")
    const names = [...source.matchAll(/\.command\("([^"]+)"/g)].map((match) => match[1]!)
    expect(names.length).toBeGreaterThanOrEqual(10)
    const page = read("docs/reference/cli.md")
    for (const name of names) {
      expect(page, `reference/cli.md never documents the ${name} command`).toContain(name)
    }
  })

  it("keeps prose on the kinds ci actually merges", () => {
    // `ciKinds` gained "docs" with the workspace import, so pages carried over
    // from the standalone repo still claimed the docs verb stays out of ci.
    const source = read("../build-cli/src/Cli.ts")
    const literal = source.match(/const ciKinds = \[([^\]]*)\]/)
    expect(literal, "Cli.ts no longer declares ciKinds").not.toBeNull()
    const kinds = [...literal![1]!.matchAll(/"([^"]+)"/g)].map((match) => match[1]!)
    expect(kinds).toContain("docs")
    // The claims wrap across lines, so the scan is per paragraph: one that
    // speaks of documentation may not also call it excluded from ci.
    const exclusion = /(?:\bnot\b|\bnever\b)[\s\S]{0,60}?(?:part of|merged into|folded into)[\s\S]{0,60}?\bci\b/i
    for (const file of proseFiles()) {
      for (const paragraph of read(file).split(/\n{2,}/)) {
        if (!/\bdocs\b|\bdocumentation\b/i.test(paragraph)) continue
        expect(paragraph, `${file} claims the docs verb stays out of ci`).not.toMatch(exclusion)
      }
    }
  })

  it("does not promise a declared-manager check the actions no longer make", () => {
    // `d191c9dfcf` deleted `checkDeclaredManager`. A sealed action receives the
    // layer and never the declaration, so prose promising the comparison
    // describes a guard that cannot run.
    expect(read("src/Install.ts")).not.toContain("checkDeclaredManager")
    for (const file of proseFiles()) {
      expect(read(file), `${file} promises a declared-manager check that was deleted`).not.toMatch(
        /the manager the workspace declared, the manager the composition provided/i
      )
    }
  })
})
