import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

const snapshot = (directory) => readdirSync(directory, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => {
    const path = join(entry.parentPath, entry.name)
    return [path.slice(directory.length), readFileSync(path).toString("hex")]
  })
  .sort(([left], [right]) => left.localeCompare(right))

const git = (repo, ...args) => {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", timeout: 10_000 })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

for (const outcome of [0, 42, "missing"]) {
  const status = outcome === "missing" ? 127 : outcome
  test(`recording preserves checkout state and cleans scratch state when VHS is ${outcome}`, (t) => {
    const fixture = mkdtempSync(join(tmpdir(), "record tape test "))
    t.after(() => rmSync(fixture, { recursive: true, force: true }))
    const repo = join(fixture, "checkout")
    const site = join(repo, "apps/site")
    const temp = join(fixture, "scratch space")
    const bin = join(fixture, "bin")
    for (const path of [join(site, "scripts"), join(repo, ".flows/runs/run-1"), join(repo, ".flows/cache"), join(repo, "flows/lint"), join(repo, "packages/smithers/src"), join(repo, "packages/smithers/bin"), join(repo, "node_modules"), temp, bin]) {
      mkdirSync(path, { recursive: true })
    }
    cpSync(new URL("record-tape.sh", import.meta.url), join(site, "scripts/record-tape.sh"))
    cpSync(new URL("../tapes", import.meta.url), join(site, "tapes"), { recursive: true })
    writeFileSync(join(repo, ".flows/runs/run-1/events"), Buffer.from([0, 255, 1, 10]))
    writeFileSync(join(repo, ".flows/cache/saved"), "cached result\n")
    writeFileSync(join(repo, "flows/lint/flow.mdx"), "fixture flow\n")
    writeFileSync(join(repo, "packages/smithers/src/Version.ts"), 'export const version = "fixture"\n')
    writeFileSync(join(repo, "package.json"), '{"private":true}\n')
    writeFileSync(join(repo, ".gitignore"), ".flows/\nnode_modules/\n")
    // Exercise the real tape shim, replacing only the CLI's provider-backed implementation.
    writeFileSync(join(repo, "packages/smithers/bin/smithers.mjs"), `
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
appendFileSync(process.env.VHS_CALLS, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }) + "\\n")
mkdirSync(".flows", { recursive: true })
writeFileSync(".flows/recorded", "scratch state")
`)
    git(repo, "init")
    git(repo, "add", "apps/site", "flows", "packages/smithers", "package.json", ".gitignore")
    git(repo, "-c", "user.name=Tape test", "-c", "user.email=tape@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "fixture")
    git(repo, "tag", "v-fixture")
    const head = git(repo, "rev-parse", "HEAD")
    const before = snapshot(join(repo, ".flows"))
    const report = join(fixture, "vhs.json")
    const calls = join(fixture, "calls.jsonl")
    writeFileSync(join(bin, "vhs"), `#!${process.execPath}
const fs = require("node:fs")
const { spawnSync } = require("node:child_process")
const tape = fs.readFileSync(process.argv[2], "utf8")
const root = process.env.SMITHERS_TAPE_ROOT
const commands = [...tape.matchAll(/^Type [\x60"](.*?)[\x60"]$/gm)].map((match) => match[1])
const git = (...args) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8" }).stdout.trim()
fs.writeFileSync(process.env.VHS_REPORT, JSON.stringify({
  root, cwd: process.cwd(), fresh: root ? !fs.existsSync(root + "/.flows") : false,
  flow: fs.existsSync(root + "/flows/lint/flow.mdx") ? fs.readFileSync(root + "/flows/lint/flow.mdx", "utf8") : null,
  version: fs.existsSync(root + "/packages/smithers/src/Version.ts") ? fs.readFileSync(root + "/packages/smithers/src/Version.ts", "utf8") : null,
  package: fs.existsSync(root + "/package.json"), head: git("rev-parse", "HEAD"),
  branch: git("branch", "--show-current"), tags: git("tag"),
  modules: fs.existsSync(root + "/node_modules") ? fs.realpathSync(root + "/node_modules") : null
}))
const result = spawnSync("/bin/sh", ["-ec", commands.join("\\n")], { encoding: "utf8" })
if (result.status !== 0) { process.stderr.write(result.stderr); process.exit(91) }
process.exit(${status})
`, { mode: 0o755 })
    if (outcome === "missing") {
      rmSync(join(bin, "vhs"))
      for (const [name, path] of [["dirname", "/usr/bin/dirname"], ["mktemp", "/usr/bin/mktemp"], ["cp", "/bin/cp"], ["rm", "/bin/rm"], ["git", "/usr/bin/git"], ["ln", "/bin/ln"]]) {
        symlinkSync(path, join(bin, name))
      }
    }
    const result = spawnSync("/bin/sh", [join(site, "scripts/record-tape.sh")], {
      cwd: fixture,
      env: { ...process.env, PATH: outcome === "missing" ? bin : `${bin}:${process.env.PATH}`, TMPDIR: temp, VHS_REPORT: report, VHS_CALLS: calls, TERM: "xterm" },
      encoding: "utf8",
      timeout: 10_000
    })
    assert.deepEqual(snapshot(join(repo, ".flows")), before)
    assert.deepEqual(readdirSync(temp), [])
    assert.equal(git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm).length, 1)
    assert.equal(result.status, status, result.stderr)
    if (outcome === "missing") return
    const recorded = JSON.parse(readFileSync(report, "utf8"))
    assert.ok(recorded.root.startsWith(`${temp}/`))
    assert.equal(recorded.cwd, realpathSync(repo))
    assert.equal(recorded.fresh, true)
    assert.equal(recorded.flow, "fixture flow\n")
    assert.equal(recorded.version, 'export const version = "fixture"\n')
    assert.equal(recorded.package, true)
    assert.equal(recorded.head, head)
    assert.equal(recorded.branch, "")
    assert.equal(recorded.tags, "v-fixture")
    assert.equal(recorded.modules, realpathSync(join(repo, "node_modules")))
    const recordedCalls = readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line))
    assert.equal(recordedCalls.length, 7)
    for (const call of recordedCalls) {
      assert.equal(call.cwd, join(realpathSync(temp), recorded.root.slice(temp.length)), `missing scratch cwd: ${call.args}`)
    }
  })
}

test("visible tape commands keep scratch setup off screen", () => {
  const tape = readFileSync(new URL("../tapes/cli.tape", import.meta.url), "utf8")
  const visible = tape.slice(tape.indexOf("\nShow\n"))
  assert.doesNotMatch(visible, /--root|SMITHERS_TAPE_ROOT/)
})
