import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { benchmark, compare } from "./bench/gate.mjs"
import { latencyReport } from "./bench/corpus.mjs"

test("cost gate rejects more work, less useful output, missing metrics and reduced fixtures", () => {
  const row = { id: "fixture", size: 10, outputDigest: "independent-output", validated: true, counts: { queries: 100 } }
  const baseline = { maxIncrease: 0.05, cases: [row] }
  compare([row], baseline)
  compare([{ ...row, counts: { queries: 105 } }], baseline)
  for (const value of [
    { ...row, counts: { queries: 106 } }, { ...row, counts: { queries: -1 } },
    { ...row, counts: {} }, { ...row, validated: false }, { ...row, size: 9 },
    { ...row, outputDigest: "skipped-work", counts: { queries: 1 } }
  ]) assert.throws(() => compare([value], baseline))
  assert.throws(() => compare([], baseline))
})

test("benchmark failure evidence is preserved before any new workload starts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "smithers-bench-preservation-"))
  try {
    const prior = join(directory, "failure.json")
    writeFileSync(prior, "prior failure")
    await assert.rejects(benchmark({ output: directory }), /fresh output directory/)
    assert.equal(readFileSync(prior, "utf8"), "prior failure")
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("observed latency tails require enough actual samples and retain their units", () => {
  for (const size of [19, 20, 21, 99, 100, 101]) {
    const samples = Array.from({ length: size }, (_, index) => index + 1).reverse()
    const report = latencyReport(samples, "receipt")
    assert.equal(report.samples, size)
    assert.equal(report.maxMs, size)
    assert.equal(report.p95Ms, size < 20 ? null : Math.ceil(size * 0.95))
    assert.equal(report.p99Ms, size < 100 ? null : Math.ceil(size * 0.99))
    assert.deepEqual(report.rawMs, samples)
  }
  assert.throws(() => latencyReport([], "receipt"))
  assert.throws(() => latencyReport([NaN], "receipt"))
})
