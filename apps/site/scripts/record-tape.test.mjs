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

for (const outcome of [0, 42, "missing"]) {
  const status = outcome === "missing" ? 127 : outcome
  test(`recording preserves checkout state and cleans scratch state when VHS is ${outcome}`, (t) => {
    const fixture = mkdtempSync(join(tmpdir(), "record tape test "))
    t.after(() => rmSync(fixture, { recursive: true, force: true }))
    const repo = join(fixture, "checkout")
    const site = join(repo, "apps/site")
    const temp = join(fixture, "scratch space")
    const bin = join(fixture, "bin")
    for (const path of [join(site, "scripts"), join(repo, ".flows/runs/run-1"), join(repo, ".flows/cache"), join(repo, "flows/lint"), temp, bin]) {
      mkdirSync(path, { recursive: true })
    }
    cpSync(new URL("record-tape.sh", import.meta.url), join(site, "scripts/record-tape.sh"))
    cpSync(new URL("../tapes", import.meta.url), join(site, "tapes"), { recursive: true })
    writeFileSync(join(repo, ".flows/runs/run-1/events"), Buffer.from([0, 255, 1, 10]))
    writeFileSync(join(repo, ".flows/cache/saved"), "cached result\n")
    writeFileSync(join(repo, "flows/lint/flow.mdx"), "fixture flow\n")
    const before = snapshot(join(repo, ".flows"))
    const report = join(fixture, "vhs.json")
    writeFileSync(join(bin, "vhs"), `#!${process.execPath}
const fs = require("node:fs")
const { spawnSync } = require("node:child_process")
const tape = fs.readFileSync(process.argv[2], "utf8")
const root = process.env.SMITHERS_TAPE_ROOT
const commands = [...tape.matchAll(/^Type [\x60"](smithers .*?)[\x60"]$/gm)].map((match) => match[1])
const calls = []
for (const command of commands) {
  const result = spawnSync("/bin/sh", ["-c", 'smithers() { printf "%s\\\\n" "$@"; }; ' + command], { encoding: "utf8" })
  if (result.status !== 0) process.exit(91)
  calls.push(result.stdout.trim().split("\\n"))
}
fs.writeFileSync(process.env.VHS_REPORT, JSON.stringify({ root, calls, cwd: process.cwd(), fresh: root ? !fs.existsSync(root + "/.flows") : false, flow: root && fs.existsSync(root + "/flows/lint/flow.mdx") ? fs.readFileSync(root + "/flows/lint/flow.mdx", "utf8") : null }))
if (root) {
  fs.mkdirSync(root + "/.flows", { recursive: true })
  fs.writeFileSync(root + "/.flows/recorded", "scratch state")
}
process.exit(${status})
`, { mode: 0o755 })
    if (outcome === "missing") {
      rmSync(join(bin, "vhs"))
      for (const [name, path] of [["dirname", "/usr/bin/dirname"], ["mktemp", "/usr/bin/mktemp"], ["cp", "/bin/cp"], ["rm", "/bin/rm"]]) {
        symlinkSync(path, join(bin, name))
      }
    }
    const result = spawnSync("/bin/sh", [join(site, "scripts/record-tape.sh")], {
      cwd: fixture,
      env: { ...process.env, PATH: outcome === "missing" ? bin : `${bin}:${process.env.PATH}`, TMPDIR: temp, VHS_REPORT: report },
      encoding: "utf8",
      timeout: 10_000
    })
    assert.equal(result.status, status, result.stderr)
    assert.deepEqual(snapshot(join(repo, ".flows")), before)
    assert.deepEqual(readdirSync(temp), [])
    if (outcome === "missing") return
    const recorded = JSON.parse(readFileSync(report, "utf8"))
    assert.ok(recorded.root.startsWith(`${temp}/`))
    assert.equal(recorded.cwd, realpathSync(repo))
    assert.equal(recorded.fresh, true)
    assert.equal(recorded.flow, "fixture flow\n")
    assert.equal(recorded.calls.length, 7)
    for (const args of recorded.calls) {
      assert.equal(args[args.indexOf("--root") + 1], recorded.root, `missing scratch --root: ${args}`)
    }
  })
}
