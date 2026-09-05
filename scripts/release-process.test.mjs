import assert from "node:assert/strict"
import { test } from "node:test"
import { captureProcess } from "./release-process.mjs"

const node = (source, options) => captureProcess(process.execPath, ["--eval", source], process.cwd(), options)

test("drains all output before classifying a successful release probe", async () => {
  const result = await node('process.stdout.write("x".repeat(200_000)); process.stderr.write("end")')
  assert.deepEqual(result, { ok: true, output: "x".repeat(200_000) + "end" })
})

test("a nonzero probe retains its diagnostics and failing outcome", async () => {
  const result = await node('process.stdout.write("partial"); process.stderr.write("failure"); process.exitCode = 9')
  assert.equal(result.ok, false)
  assert.ok(result.output.startsWith("partialfailure"))
})

test("noninteractive probes receive EOF instead of waiting for input", async () => {
  const result = await node('process.stdin.on("end", () => process.stdout.write("eof")); process.stdin.resume()', {
    timeoutMs: 5000
  })
  assert.deepEqual(result, { ok: true, output: "eof" })
})

test("an executable that cannot start produces a useful failed result", async () => {
  const result = await captureProcess("/nonexistent/smthrs-release-probe", [], process.cwd())
  assert.equal(result.ok, false)
  assert.match(result.output, /ENOENT/)
})

test("a probe that never terminates is killed within its budget", async () => {
  const result = await node("setInterval(() => {}, 1000)", { timeoutMs: 100 })
  assert.equal(result.ok, false)
  assert.match(result.output, /Command failed/)
})

test("excessive probe output fails rather than growing the gate without bound", async () => {
  const result = await node('process.stdout.write("x".repeat(200_000))', { maxOutputBytes: 4096 })
  assert.equal(result.ok, false)
  assert.match(result.output, /maxBuffer/)
  assert.ok(result.output.length < 8192)
})
