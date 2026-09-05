import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { promisify } from "node:util"
import { setTimeout as delay } from "node:timers/promises"
import { campaignConfiguration, expectedDiff, runCampaign, verifyCampaign, verifyParser } from "./run-jj-abi-campaign.mjs"

const configuration = { seed: 0, cases: 1, steps: 1 }
const fixture = () => {
  const before = "seed 0 step 0 value 1013904223\n"
  const operation = { index: 0, first: { ok: { changeId: "klmnopqrstuv" } }, second: { ok: { changeId: "lmnopqrstuvw" } }, diff: { ok: { diff: expectedDiff(before) } }, failure: { err: { code: "invalid_ref", command: "jj restore --from kkkkkkkkkkkk", message: 'revision "kkkkkkkkkkkk" doesn\'t exist' } }, restore: { ok: {} }, health: { ok: { diff: "" } }, restoredText: before }
  operation.revisits = Array.from({ length: 3 }, () => ({ target: 0, response: { ok: {} }, restoredText: before, health: { ok: { diff: "" } } }))
  const unicodeLength = Buffer.byteLength('{"op":"snapshot","root":"/repo","message":"文件🚀"}')
  const common = { schemaVersion: 1, status: "passed", seed: 0, requestedCases: 1, executedCases: 1, requestedSteps: 1, executedSteps: 1, healthChecks: 1, requests: [{ index: 0, inputHex: "ff", response: { err: { code: "unknown", command: "jj", message: "jj: malformed request: fixture" } } }], operations: [operation] }
  return {
    native: { ...structuredClone(common), tier: "native" },
    wasm: { ...structuredClone(common), tier: "wasm", wasmSha256: "fixture-wasm", corpusSha256: createHash("sha256").update("ff").digest("hex"), allocations: 10, frees: 10, liveAllocations: 0, openHostFiles: 0, exchanges: 5, initialMemoryBytes: 65536, currentMemoryBytes: 131072, peakMemoryBytes: 131072, peakLiveBytes: 1048577, boundaryLengths: [29, 30, 31], healthChecks: 13 + unicodeLength, truncatedLengths: Array.from({ length: unicodeLength }, (_, index) => index), rejectedAllocations: [2147483648, 4294967295], growthFailures: 1 }
  }
}

test("ABI campaign accepts only bounded unsigned replay parameters", () => {
  assert.deepEqual(campaignConfiguration({}), { seed: 20260904, cases: 5000, steps: 32 })
  assert.equal(campaignConfiguration({ SMITHERS_ABI_SEED: "4294967295" }).seed, 4294967295)
  assert.equal(campaignConfiguration({ SMITHERS_ABI_SEED: "0" }).seed, 0)
  for (const env of [{ SMITHERS_ABI_SEED: "4294967296" }, { SMITHERS_ABI_SEED: "-1" }, { SMITHERS_ABI_CASES: "0" }, { SMITHERS_ABI_CASES: "100001" }, { SMITHERS_ABI_STEPS: "257" }, { SMITHERS_ABI_STEPS: "NaN" }]) assert.throws(() => campaignConfiguration(env), /integer range/)
})

test("complete matching native and WASM execution evidence is accepted", () => {
  const { native, wasm } = fixture()
  assert.equal(verifyCampaign(native, wasm, configuration, "fixture-wasm").corpusSha256, wasm.corpusSha256)
})

test("parser-only evidence must include every requested raw and grammar case", () => {
  const report = { schemaVersion: 1, tier: "parser", status: "passed", seed: 0, requestedCases: 1, executedRawCases: 1, executedGrammarCases: 1 }
  verifyParser(report, configuration)
  for (const key of Object.keys(report)) {
    const incomplete = { ...report }
    delete incomplete[key]
    assert.throws(() => verifyParser(incomplete, configuration), key)
  }
  for (const patch of [{ status: "running" }, { seed: 1 }, { executedRawCases: 0 }, { executedGrammarCases: 0 }, { executedGrammarCases: 2 }]) {
    assert.throws(() => verifyParser({ ...report, ...patch }, configuration))
  }
})

test("missing, truncated, stale and wrong-corpus evidence is refused", () => {
  const changes = [
    ["native", "status", "running"], ["native", "seed", 1], ["native", "executedCases", 0], ["wasm", "executedSteps", 0],
    ["native", "requests", []], ["wasm", "operations", []], ["native", "healthChecks", 0],
    ["wasm", "corpusSha256", "other"], ["wasm", "wasmSha256", "other"], ["wasm", "liveAllocations", 1],
    ["wasm", "openHostFiles", 1], ["wasm", "frees", 9], ["wasm", "peakMemoryBytes", 100000000], ["wasm", "boundaryLengths", [1, 2, 4]],
    ["wasm", "healthChecks", 1], ["wasm", "truncatedLengths", [0]], ["wasm", "rejectedAllocations", []], ["wasm", "growthFailures", 0]
  ]
  for (const [tier, field, value] of changes) {
    const reports = fixture()
    reports[tier][field] = value
    assert.throws(() => verifyCampaign(reports.native, reports.wasm, configuration, "fixture-wasm"), `${tier}.${field}`)
  }
  const { native, wasm } = fixture()
  wasm.requests[0].response.err.message = "jj: malformed request: different diagnostic"
  assert.throws(() => verifyCampaign(native, wasm, configuration, "fixture-wasm"))
  wasm.requests[0].inputHex = "fe"
  assert.throws(() => verifyCampaign(native, wasm, configuration, "fixture-wasm"))
  native.requests[0].response.err.command = "wrong"
  assert.throws(() => verifyCampaign(native, wasm, configuration, "fixture-wasm"))
})

test("every operation requires its complete seeded result and restored file bytes in both tiers", () => {
  const mutations = [
    (op) => { for (const key of Object.keys(op)) delete op[key] },
    (op) => { op.index = 1 },
    (op) => { op.first = { err: {} } },
    (op) => { op.first.ok.extra = true },
    (op) => { op.first.ok.changeId = "ABCDEF123456" },
    (op) => { op.second.ok.changeId = op.first.ok.changeId },
    (op) => { op.second.extra = true },
    (op) => { op.second.ok.changeId = "klmnopqrstuvx" },
    (op) => { op.diff.ok.diff = "+changed\n" },
    (op) => { op.diff.ok.diff = op.diff.ok.diff.replace("@@ -1,1 +1,2 @@", "@@ -1,2 +1,3 @@") },
    (op) => { op.diff.ok.diff = op.diff.ok.diff.replace(/index [a-f0-9]/, "index 0") },
    (op) => { op.diff.ok.diff = op.diff.ok.diff.replace("1013904223", "1013904224") },
    (op) => { op.diff.ok.extra = true },
    (op) => { op.failure.err.message = "doesn't exist" },
    (op) => { op.failure.err.command = "jj" },
    (op) => { delete op.restore },
    (op) => { op.restore = { err: {} } },
    (op) => { op.health.ok.diff = "+changed\n" },
    (op) => { op.restoredText = op.restoredText.trimEnd() },
    (op) => { op.restoredText = "seed 0 step 0 value 0\n" },
    (op) => { delete op.revisits },
    (op) => { op.revisits.pop() },
    (op) => { op.revisits[0].target = 1 },
    (op) => { op.revisits[1].restoredText += "changed\n" },
    (op) => { op.revisits[2].health.ok.diff = "changed" }
  ]
  for (const tier of ["native", "wasm"]) {
    for (const [index, mutate] of mutations.entries()) {
      const reports = fixture()
      mutate(reports[tier].operations[0])
      assert.throws(() => verifyCampaign(reports.native, reports.wasm, configuration, "fixture-wasm"), `${tier} operation mutation ${index}`)
    }
  }
})

test("campaign preserves existing evidence and refuses reuse before spawning a tier", async () => {
  const root = await mkdtemp(join(tmpdir(), "smithers-abi-evidence-test-"))
  try {
    await writeFile(join(root, "native.json"), "original evidence")
    await assert.rejects(runCampaign(configuration, root), /Refusing to overwrite/)
    assert.equal(await readFile(join(root, "native.json"), "utf8"), "original evidence")
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("missing real WASM artifact fails the executable campaign before native or WASM work can be claimed", async () => {
  const root = await mkdtemp(join(tmpdir(), "smithers-abi-missing-wasm-"))
  try {
    await mkdir(join(root, "scripts"))
    const executable = join(root, "scripts", "run-jj-abi-campaign.mjs")
    const evidence = join(root, "evidence")
    await copyFile(new URL("./run-jj-abi-campaign.mjs", import.meta.url), executable)
    await assert.rejects(promisify(execFile)(process.execPath, [executable], {
      env: { ...process.env, SMITHERS_ABI_SEED: "0", SMITHERS_ABI_CASES: "1", SMITHERS_ABI_STEPS: "1", SMITHERS_ABI_ARTIFACT_DIR: evidence }
    }), /ENOENT/)
    const report = JSON.parse(await readFile(join(evidence, "campaign.json"), "utf8"))
    assert.equal(report.status, "failed")
    assert.match(report.error, /flows_jj\.wasm/)
    await assert.rejects(readFile(join(evidence, "native.json")), { code: "ENOENT" })
    await assert.rejects(readFile(join(evidence, "wasm.json")), { code: "ENOENT" })
  } finally { await rm(root, { recursive: true, force: true }) }
})

const eventually = async (condition, description) => {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    if (await condition()) return
    await delay(20)
  }
  assert.fail(`Timed out waiting for ${description}`)
}
const alive = async (pid) => {
  try { process.kill(pid, 0) }
  catch (error) { if (error.code === "ESRCH") return false; throw error }
  // An orphan awaiting init's reap has exited and cannot retain resources.
  if (process.platform === "linux") {
    try { if (/^\d+ \(.*\) Z /.test(await readFile(`/proc/${pid}/stat`, "utf8"))) return false }
    catch (error) { if (error.code === "ENOENT") return false; throw error }
  }
  return true
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  test(`${signal} interrupts a real running tier, retires its process group and records interruption`, { skip: process.platform === "win32", timeout: 20000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "smithers-abi-interruption-"))
    let parent
    let pids
    try {
      await mkdir(join(root, "scripts"))
      await mkdir(join(root, "bin"))
      await mkdir(join(root, "packages/smithers/flows/jj/wasm"), { recursive: true })
      await writeFile(join(root, "packages/smithers/flows/jj/wasm/flows_jj.wasm"), "fixture bytes, never instantiated")
      const executable = join(root, "scripts", "run-jj-abi-campaign.mjs")
      const evidence = join(root, "evidence")
      const pidPath = join(root, "owned-processes.json")
      await copyFile(new URL("./run-jj-abi-campaign.mjs", import.meta.url), executable)
      const cargo = join(root, "bin", "cargo")
      await writeFile(cargo, `#!${process.execPath}\nconst {spawn}=require('node:child_process');const fs=require('node:fs');process.on('SIGTERM',()=>{});const worker=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});fs.writeFileSync(process.env.SMITHERS_OWNED_PID_FILE,JSON.stringify({leader:process.pid,worker:worker.pid}));setInterval(()=>{},1000);\n`)
      await chmod(cargo, 0o755)
      parent = spawn(process.execPath, [executable], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, SMITHERS_OWNED_PID_FILE: pidPath, SMITHERS_ABI_SEED: "0", SMITHERS_ABI_CASES: "1", SMITHERS_ABI_STEPS: "1", SMITHERS_ABI_ARTIFACT_DIR: evidence } })
      let output = ""
      parent.stdout.on("data", (bytes) => { output += bytes })
      parent.stderr.on("data", (bytes) => { output += bytes })
      const completion = new Promise((resolve, reject) => { parent.once("error", reject); parent.once("close", (code, stoppedBy) => resolve({ code, stoppedBy })) })
      await eventually(async () => {
        try { pids = JSON.parse(await readFile(pidPath, "utf8")); return true }
        catch (error) { if (error.code === "ENOENT") return false; throw error }
      }, "owned tier and descendant startup")
      assert.equal(await alive(pids.leader), true)
      assert.equal(await alive(pids.worker), true)
      parent.kill(signal)
      await eventually(() => parent.exitCode !== null, "runner interruption exit")
      assert.deepEqual(await completion, { code: signal === "SIGINT" ? 130 : 143, stoppedBy: null }, output)
      await eventually(async () => !(await alive(pids.leader)) && !(await alive(pids.worker)), "owned tier and descendant exit")
      const report = JSON.parse(await readFile(join(evidence, "campaign.json"), "utf8"))
      assert.equal(report.status, "interrupted")
      assert.equal(report.signal, signal)
      assert.match(report.error, new RegExp(`interrupted by ${signal}`))
      assert.equal(report.nativeEvidenceSha256, undefined)
      await assert.rejects(readFile(join(evidence, "native.json")), { code: "ENOENT" })
      await assert.rejects(readFile(join(evidence, "wasm.log")), { code: "ENOENT" })
    } finally {
      if (parent && parent.exitCode === null) parent.kill("SIGKILL")
      if (pids) {
        try { process.kill(-pids.leader, "SIGKILL") }
        catch (error) { if (error.code !== "ESRCH") throw error }
      }
      await rm(root, { recursive: true, force: true })
    }
  })
}
