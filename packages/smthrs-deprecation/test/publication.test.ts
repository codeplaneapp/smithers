import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { notice } from "./golden.ts"

const url = (path: string): URL => new URL(path, import.meta.url)
const manifest = JSON.parse(readFileSync(url("../package.json"), "utf8")) as {
  readonly bin?: unknown
  readonly dependencies?: unknown
  readonly engines?: { readonly node?: string }
  readonly exports?: unknown
  readonly sideEffects?: unknown
  readonly publishConfig?: { readonly access?: string; readonly tag?: string }
}

describe("the published manifest", () => {
  it("ships no bin, which is what makes the smithers-build rename collision-free", () => {
    // Contract section 3.4 renames the private build CLI's binary to
    // `smithers-build` and justifies it with "the deprecation package `smthrs`
    // ships no bin, so no `PATH` collision exists between the two names". A bin
    // added here would shadow @smthrs/cli's `smithers` on every machine that
    // installs both.
    expect(manifest.bin).toBeUndefined()
  })

  it("declares no dependencies, so installing the notice installs nothing else", () => {
    expect(manifest.dependencies).toBeUndefined()
  })

  it("keeps the side effect that is the whole package", () => {
    // A bundler told this module is side-effect free may drop the import, and
    // dropping the import drops the notice.
    expect(manifest.sideEffects).toBe(true)
  })

  it("exports the root and nothing else", () => {
    // Contract sections 3.3 and 3.5: `smthrs` exports `.` only.
    expect(manifest.exports).toEqual({ ".": "./src/index.ts" })
  })

  it("publishes publicly under the rc dist-tag, so it never becomes an accidental install", () => {
    expect(manifest.publishConfig?.access).toBe("public")
    expect(manifest.publishConfig?.tag).toBe("rc")
  })

  it("declares a Node floor an unmigrated 0.x project can still satisfy", () => {
    // The repository floor of 22.19.0 is a claim about running the durable
    // engine, which this package never does. Carrying it here lets an
    // `engine-strict` install fail with EBADENGINE on the Node a 0.x project
    // runs today, which replaces the migration notice with a Node version
    // complaint.
    expect(manifest.engines?.node).toBe(">=14")
  })
})

const dist = fileURLToPath(url("../dist"))
const builtEsm = fileURLToPath(url("../dist/esm/index.js"))
const builtCjs = fileURLToPath(url("../dist/cjs/index.js"))
const built = existsSync(dist)

// The published entries are built artifacts, not `src/index.ts`. A fresh
// checkout has no `dist/`, so these skip rather than fail. Once any build has
// created `dist/`, every published entry must be present: a partial build is a
// broken artifact, not another reason to skip the suite.
describe.skipIf(!built)("the built entries a consumer actually loads", () => {
  it("throws the notice through the ESM entry", async () => {
    const failure = await import(url("../dist/esm/index.js").href).then(
      () => undefined,
      (error: unknown) => error as Error
    )

    expect(failure?.message).toBe(notice)
  })

  it("throws the notice through the CJS entry", () => {
    const require_ = createRequire(import.meta.url)

    expect(() => require_(builtCjs)).toThrow(notice)
  })

  it("declares no importable type surface, because no import can ever resolve one", () => {
    // A declared export type-checks and then throws at run time, which is the
    // type-versus-runtime drift the umbrella used to be guarded against.
    const types = readFileSync(url("../dist/esm/index.d.ts"), "utf8")

    expect(types).not.toMatch(/export declare|export \{ [A-Za-z]/)
  })
})
