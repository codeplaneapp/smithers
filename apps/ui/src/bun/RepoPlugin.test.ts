import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PLUGIN_MANIFEST, readRepoPlugin } from "./RepoPlugin"

/*
 * The repo plugin manifest read (LOCAL-APP.md "Plugin manifest"): a valid
 * `.smithers/UI.json` parses against the detected workspaces; an absent
 * manifest is no plugin and no warning; anything invalid — bad JSON, extra
 * keys, a bad kind, an undeclared group or workspace — becomes repo
 * warnings with the plugin undefined, never a throw.
 */

const directories: Array<string> = []
afterAll(async () => {
  await Promise.all(directories.map((dir) => rm(dir, { recursive: true, force: true })))
})

const scratch = async (): Promise<string> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "smithers-plugin-")))
  directories.push(dir)
  await mkdir(join(dir, ".smithers"), { recursive: true })
  return dir
}

const manifest = {
  schemaVersion: 1,
  name: "aomi",
  title: "Aomi",
  summary: "Cross-repo workflows.",
  groups: [{ id: "checks", title: "Checks", kind: "check" }],
  entries: [
    { id: "check", group: "checks", workspace: ".", label: "//:check", title: "Check everything", summary: "One gate." },
    { id: "clippy", group: "checks", workspace: "aomi-sdk", label: "//:clippyFix", title: "Clippy", summary: "Green." }
  ]
}

const writeManifest = async (dir: string, value: unknown): Promise<void> => {
  await writeFile(join(dir, PLUGIN_MANIFEST), typeof value === "string" ? value : JSON.stringify(value))
}

describe("readRepoPlugin", () => {
  test("a repo without the manifest has no plugin and no warnings", async () => {
    const dir = await scratch()
    expect(readRepoPlugin(dir, ["."])).toEqual({ plugin: undefined, warnings: [] })
  })

  test("a valid manifest parses against the detected workspaces", async () => {
    const dir = await scratch()
    await writeManifest(dir, manifest)
    const read = readRepoPlugin(dir, [".", "aomi-sdk"])
    expect(read.warnings).toEqual([])
    expect(read.plugin?.name).toBe("aomi")
    expect(read.plugin?.entries[0]).toMatchObject({ approval: false, agentic: false })
  })

  test("invalid JSON is a warning, never a throw", async () => {
    const dir = await scratch()
    await writeManifest(dir, "{ not json")
    const read = readRepoPlugin(dir, ["."])
    expect(read.plugin).toBeUndefined()
    expect(read.warnings).toHaveLength(1)
    expect(read.warnings[0]).toContain(PLUGIN_MANIFEST)
  })

  test("extra keys, a bad kind, an undeclared group and an undetected workspace are warnings", async () => {
    const dir = await scratch()
    await writeManifest(dir, { ...manifest, extra: true })
    expect(readRepoPlugin(dir, [".", "aomi-sdk"]).plugin).toBeUndefined()

    await writeManifest(dir, { ...manifest, groups: [{ id: "checks", title: "Checks", kind: "nope" }] })
    expect(readRepoPlugin(dir, [".", "aomi-sdk"]).plugin).toBeUndefined()

    await writeManifest(dir, { ...manifest, entries: [{ ...manifest.entries[0], group: "missing" }] })
    const group = readRepoPlugin(dir, [".", "aomi-sdk"])
    expect(group.plugin).toBeUndefined()
    expect(group.warnings.join(" ")).toContain("missing")

    await writeManifest(dir, manifest)
    const workspace = readRepoPlugin(dir, ["."])
    expect(workspace.plugin).toBeUndefined()
    expect(workspace.warnings.join(" ")).toContain("aomi-sdk")
  })
})
