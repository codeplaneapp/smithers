import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { expect, it } from "vitest"

const packageRoot = fileURLToPath(new URL("..", import.meta.url))

it("ships every default template file and scaffolds its ignore rules from the npm tarball", () => {
  const templateFiles = readdirSync(join(packageRoot, "template/default"), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(packageRoot, join(entry.parentPath, entry.name)).replaceAll("\\", "/"))
    .sort()
  const reference = readFileSync(join(packageRoot, "docs/reference/templates.md"), "utf8")
  const documentedCount = Number(reference.match(/\| Files copied\s*\| (\d+)/)?.[1])

  const destination = mkdtempSync(join(tmpdir(), "smithers-create-app-pack-"))
  try {
    const packed = JSON.parse(
      execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", destination], {
        cwd: packageRoot,
        timeout: 60_000,
        encoding: "utf8",
        stdio: "pipe"
      })
    ) as Array<{ filename: string }>
    expect(packed).toHaveLength(1)
    const tarball = join(destination, packed[0]!.filename)
    const entries = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8", timeout: 10_000 })
      .trim().split("\n")
    expect(entries.filter((path) => path.startsWith("package/template/") && path.endsWith("/.gitignore"))).toEqual([])
    const packedFiles = entries
      .filter((path) => path.startsWith("package/template/default/") && !path.endsWith("/"))
      .map((path) => path.slice("package/".length))
      .sort()
    expect(packedFiles).toEqual(templateFiles)
    expect(packedFiles).toHaveLength(documentedCount)
    expect(packedFiles).toContain("template/default/_gitignore")

    execFileSync("tar", ["-xzf", tarball, "-C", destination], { timeout: 10_000 })
    const directory = join(destination, "ledger")
    // Use the real scaffolder with only the extracted package as its template root.
    const scaffolder = pathToFileURL(join(packageRoot, "../build/build-cli/src/CreateApp.ts")).href
    execFileSync(process.execPath, [
      "--input-type=module",
      "--eval",
      "const { scaffold } = await import(process.argv[1]); await scaffold({ directory: process.argv[2], templateRoot: process.argv[3] })",
      scaffolder,
      directory,
      join(destination, "package/template")
    ], { cwd: destination, timeout: 10_000, stdio: "pipe" })
    const rules = readFileSync(join(packageRoot, "template/default/_gitignore"), "utf8")
    expect(readFileSync(join(destination, "package/template/default/_gitignore"), "utf8")).toBe(rules)
    expect(readFileSync(join(directory, ".gitignore"), "utf8")).toBe(rules)
    expect(existsSync(join(directory, "_gitignore"))).toBe(false)
    expect(reference).toMatch(/\| `_gitignore` \(`default`\)\s*\|[^\n]*writes `\.gitignore`/)
  } finally {
    rmSync(destination, { recursive: true, force: true })
  }
}, 90_000)
