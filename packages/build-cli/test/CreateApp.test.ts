/**
 * `smthrs create-app` copies a directory and substitutes one placeholder, so
 * what these tests hold down is the part a copy cannot get right by itself: the
 * refusals, the name substitution reaching every file kind, and the `link:`
 * rewrite that makes a scaffold from a checkout installable before the
 * `@smthrs/*` packages are published.
 */
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import { makeCli } from "../src/Cli.ts"
import { scaffold, templateRoot, templates } from "../src/CreateApp.ts"

const temporary = async (prefix: string): Promise<string> =>
  Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), prefix)))

/** A two-file template plus a `packages/` sibling, so `link:` has something to find. */
const fixture = async (): Promise<{ readonly root: string; readonly templates: string }> => {
  const root = await temporary("smthrs-create-app-")
  const templateDir = NodePath.join(root, "packages", "create-app", "template", "demo")
  await Fs.mkdir(NodePath.join(templateDir, "app"), { recursive: true })
  await Fs.writeFile(
    NodePath.join(templateDir, "package.json"),
    JSON.stringify(
      {
        name: "__APP_NAME__",
        dependencies: { "@smthrs/create-app": "0.1.0", effect: "4.0.0-rc.108" },
        devDependencies: { "@smthrs/absent": "0.1.0", typescript: "6.0.3" }
      },
      null,
      2
    )
  )
  await Fs.writeFile(NodePath.join(templateDir, "README.md"), "# __APP_NAME__\n")
  await Fs.writeFile(NodePath.join(templateDir, "app", "page.tsx"), "export default () => \"__APP_NAME__\"\n")
  await Fs.writeFile(NodePath.join(templateDir, "logo.svg"), "<svg><!-- __APP_NAME__ --></svg>")
  // The sibling package `link:` should find. `@smthrs/absent` has no directory
  // here, so it must keep its declared version.
  await Fs.writeFile(
    NodePath.join(root, "packages", "create-app", "package.json"),
    JSON.stringify({ name: "@smthrs/create-app", version: "0.1.0" })
  )
  return { root, templates: NodePath.join(root, "packages", "create-app", "template") }
}

describe("templates", () => {
  it("finds the templates that ship with @smthrs/create-app", async () => {
    const names = await templates(templateRoot())
    expect(names).toContain("default")
  })
})

describe("scaffold", () => {
  it("copies the template and puts the directory name everywhere the placeholder was", async () => {
    const source = await fixture()
    const directory = NodePath.join(await temporary("smthrs-scaffold-"), "ledger")
    const report = await scaffold({ directory, template: "demo", templateRoot: source.templates })

    expect(report.name).toBe("ledger")
    expect(report.template).toBe("demo")
    expect(report.files).toBe(4)
    const manifest = JSON.parse(await Fs.readFile(NodePath.join(directory, "package.json"), "utf8")) as {
      readonly name: string
    }
    expect(manifest.name).toBe("ledger")
    expect(await Fs.readFile(NodePath.join(directory, "README.md"), "utf8")).toBe("# ledger\n")
    expect(await Fs.readFile(NodePath.join(directory, "app", "page.tsx"), "utf8")).toContain("\"ledger\"")
    // A file kind the substitution list does not cover is copied byte for byte.
    expect(await Fs.readFile(NodePath.join(directory, "logo.svg"), "utf8")).toContain("__APP_NAME__")
  })

  it("links the @smthrs packages that exist beside the template, and only those", async () => {
    const source = await fixture()
    const directory = NodePath.join(await temporary("smthrs-scaffold-"), "ledger")
    const report = await scaffold({ directory, template: "demo", templateRoot: source.templates })

    expect(report.linked).toEqual(["@smthrs/create-app"])
    const manifest = JSON.parse(await Fs.readFile(NodePath.join(directory, "package.json"), "utf8")) as {
      readonly dependencies: Record<string, string>
      readonly devDependencies: Record<string, string>
    }
    expect(manifest.dependencies["@smthrs/create-app"]).toBe(
      `link:${NodePath.join(source.root, "packages", "create-app")}`
    )
    // A package with no directory beside the template keeps its version, and a
    // non-@smthrs dependency is never touched.
    expect(manifest.devDependencies["@smthrs/absent"]).toBe("0.1.0")
    expect(manifest.dependencies["effect"]).toBe("4.0.0-rc.108")
  })

  it("keeps the declared versions under --no-link", async () => {
    const source = await fixture()
    const directory = NodePath.join(await temporary("smthrs-scaffold-"), "ledger")
    const report = await scaffold({ directory, template: "demo", templateRoot: source.templates, link: false })

    expect(report.linked).toEqual([])
    const manifest = JSON.parse(await Fs.readFile(NodePath.join(directory, "package.json"), "utf8")) as {
      readonly dependencies: Record<string, string>
    }
    expect(manifest.dependencies["@smthrs/create-app"]).toBe("0.1.0")
  })

  it("names the templates it has when asked for one it does not", async () => {
    const source = await fixture()
    const directory = NodePath.join(await temporary("smthrs-scaffold-"), "ledger")
    await expect(scaffold({ directory, template: "nope", templateRoot: source.templates })).rejects.toThrow(
      "unknown template \"nope\"; available: demo"
    )
  })

  it("refuses a directory name that is not a usable app name", async () => {
    const source = await fixture()
    const directory = NodePath.join(await temporary("smthrs-scaffold-"), "Ledger App")
    await expect(scaffold({ directory, template: "demo", templateRoot: source.templates })).rejects.toThrow(
      "is not a usable app name"
    )
  })

  it("refuses a directory that already holds something", async () => {
    const source = await fixture()
    const directory = NodePath.join(await temporary("smthrs-scaffold-"), "ledger")
    await Fs.mkdir(directory, { recursive: true })
    await Fs.writeFile(NodePath.join(directory, "keep.txt"), "mine")
    await expect(scaffold({ directory, template: "demo", templateRoot: source.templates })).rejects.toThrow(
      "is not empty"
    )
    expect(await Fs.readFile(NodePath.join(directory, "keep.txt"), "utf8")).toBe("mine")
  })

  it("scaffolds into an existing empty directory", async () => {
    const source = await fixture()
    const directory = NodePath.join(await temporary("smthrs-scaffold-"), "ledger")
    await Fs.mkdir(directory, { recursive: true })
    await expect(scaffold({ directory, template: "demo", templateRoot: source.templates })).resolves.toMatchObject({
      name: "ledger"
    })
  })
})

describe("the create-app verb", () => {
  const serve = async (args: ReadonlyArray<string>) => {
    let exitCode = 0
    let output = ""
    await makeCli({}).serve([...args], {
      exit: (code) => {
        exitCode = code
      },
      stdout: (text) => {
        output += text
      }
    })
    return { exitCode, output }
  }

  it("scaffolds the shipped default template", async () => {
    const directory = NodePath.join(await temporary("smthrs-verb-"), "ledger")
    const { exitCode, output } = await serve(["create-app", directory])
    expect(exitCode).toBe(0)
    expect(output).toContain("ledger")
    expect(await Fs.readFile(NodePath.join(directory, "AGENT.ts"), "utf8")).toContain("ledger's agent")
  })

  it("exits non-zero and says why when the template is unknown", async () => {
    const directory = NodePath.join(await temporary("smthrs-verb-"), "ledger")
    const { exitCode, output } = await serve(["create-app", directory, "--template", "nope"])
    expect(exitCode).not.toBe(0)
    expect(output).toContain("unknown template")
  })
})
