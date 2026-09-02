/**
 * The two shipped template manifests, checked against the workspace they are
 * cut from.
 *
 * A template's `@smthrs/*` specifier is a literal version string, not a
 * `workspace:*` range, because a scaffolded app is not a workspace member. So
 * nothing but a test holds the two in step: both manifests pinned `0.1.0`
 * against a roster that had moved to `1.0.0-rc.0`, and every specifier in a
 * freshly scaffolded app was unresolvable. It installed anyway only because
 * `packages/build-cli`'s `linkWorkspace` rewrites those specifiers to `link:`
 * paths when it finds a source checkout.
 */
import { describe, expect, it } from "@effect/vitest"
import { Fixture } from "@smthrs/testing/Fixture"
import * as Schema from "effect/Schema"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const packageRoot = fileURLToPath(new URL("..", import.meta.url))
const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url))
const templateRoot = join(packageRoot, "template")

interface Manifest {
  readonly version?: string
  readonly private?: boolean
  readonly dependencies?: Record<string, string>
  readonly devDependencies?: Record<string, string>
}

const read = (path: string): Manifest => JSON.parse(readFileSync(path, "utf8")) as Manifest

const templates = readdirSync(templateRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

const smthrsSpecifiers = (manifest: Manifest): ReadonlyArray<readonly [string, string]> =>
  [...Object.entries(manifest.dependencies ?? {}), ...Object.entries(manifest.devDependencies ?? {})]
    .filter(([name]) => name.startsWith("@smthrs/"))
    .sort(([a], [b]) => a.localeCompare(b))

/**
 * The private workspace packages a template is allowed to depend on.
 *
 * A private package never reaches a registry, so a scaffolded app can only
 * resolve these through the `link:` rewrite. Adding a fourth is a deliberate
 * decision about what a scaffold can be installed from, so it is spelled out
 * here rather than derived: a new private dependency fails this test until
 * someone writes it down.
 */
const allowedPrivateDependencies = [
  "@smthrs/create-app",
  "@smthrs/targets",
  "@smthrs/ui",
  "@smthrs/ui-styleguide"
] as const

describe.each(templates)("template/%s", (template) => {
  const manifest = read(join(templateRoot, template, "package.json"))
  const specifiers = smthrsSpecifiers(manifest)

  it("depends on at least one workspace package", () => {
    expect(specifiers.length).toBeGreaterThan(0)
  })

  it.each(specifiers)("pins %s at the version the workspace publishes", (name, specifier) => {
    const workspace = read(join(workspaceRoot, "packages", name.slice("@smthrs/".length), "package.json"))
    expect(
      specifier,
      `template/${template} pins ${name} at ${specifier}; the workspace is at ${String(workspace.version)}`
    ).toBe(workspace.version)
  })

  it("depends on no private package outside the recorded allowlist", () => {
    const privateNames = specifiers
      .map(([name]) => name)
      .filter((name) => read(join(workspaceRoot, "packages", name.slice("@smthrs/".length), "package.json")).private
        === true)
    expect(privateNames).toEqual(privateNames.filter((name) => allowedPrivateDependencies.includes(name as never)))
  })
})

/**
 * Every fixture a template ships, decoded with the schema the replay path uses.
 *
 * A template's own suite runs against the scaffolded copy's `node_modules` and
 * never runs here, so a fixture that stopped decoding would otherwise only
 * surface in a scaffolded app. Decoding is the part of that suite this package
 * can own.
 */
describe("template fixtures", () => {
  const decode = Schema.decodeUnknownSync(Fixture)

  const fixtures = templates.flatMap((template) => {
    const flowsDir = join(templateRoot, template, "flows")
    let flows: ReadonlyArray<string> = []
    try {
      flows = readdirSync(flowsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) =>
        entry.name
      )
    } catch {
      return []
    }
    return flows.flatMap((flow) => {
      const dir = join(flowsDir, flow, "fixtures")
      let names: ReadonlyArray<string> = []
      try {
        names = readdirSync(dir).filter((name) => name.endsWith(".json"))
      } catch {
        return []
      }
      return names.map((name) => [`${template}/flows/${flow}/fixtures/${name}`, join(dir, name)] as const)
    })
  })

  it("ships at least one fixture", () => {
    expect(fixtures.length).toBeGreaterThan(0)
  })

  it.each(fixtures)("decodes %s", (_label, path) => {
    const decoded = decode(JSON.parse(readFileSync(path, "utf8")))
    expect(decoded.calls.length).toBeGreaterThan(0)
  })
})
