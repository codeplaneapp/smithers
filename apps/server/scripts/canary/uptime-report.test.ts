/*
 * The two process shells, run for real.
 *
 * uptime-checks.test.ts covers every decision. This file covers the parts a
 * pure test cannot reach: argument parsing, the real `fetch`, the JSON report
 * on disk, the exit codes, and the GITHUB_OUTPUT lines the scheduled workflow
 * reads. The deployment is replaced by a local Bun.serve that answers the same
 * shapes canary.smithers.sh answers — including the signed-out 401 from the
 * turn seam and the NDJSON stream a signed-in turn produces — so the network
 * path is exercised without a credential and without spending model credit.
 */
import type { Server } from "bun"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ALERT_TITLE, type ProbeReport } from "./uptime-checks.ts"

const scriptsDir = import.meta.dir
const serverDir = join(scriptsDir, "..", "..")
const workDir = mkdtempSync(join(tmpdir(), "canary-uptime-"))

/** How the fake deployment behaves for the run in progress. */
let mode: "healthy" | "spa-down" | "turn-open" = "healthy"

let server: Server<undefined>

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/") {
        return mode === "spa-down"
          ? new Response("upstream failure", { status: 503 })
          : new Response("<html>smithers</html>", { status: 200 })
      }
      if (url.pathname === "/api/auth/scopes") return new Response("{\"scopes\":[]}", { status: 200 })
      if (url.pathname === "/api/agent/turn") {
        if (mode === "turn-open") return new Response("streaming to anyone", { status: 200 })
        if (request.headers.get("cookie") === null) return new Response("Unauthorized", { status: 401 })
        const body = await request.json() as { runId: string }
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `${JSON.stringify({ runId: body.runId, type: "delta", kind: "text", text: "ok" })}\n`
                )
              )
              controller.close()
            }
          }),
          { status: 200, headers: { "content-type": "application/x-ndjson" } }
        )
      }
      return new Response("Not found", { status: 404 })
    }
  })
})

afterAll(() => {
  server.stop(true)
})

const origin = (): string => `http://localhost:${String(server.port)}`

const runProbe = async (
  extraArgs: ReadonlyArray<string>,
  env: Record<string, string> = {}
): Promise<{ exitCode: number; stdout: string }> => {
  const child = Bun.spawn(
    ["bun", join(scriptsDir, "uptime-probe.ts"), origin(), "--gap-ms", "1", ...extraArgs],
    {
      cwd: serverDir,
      stdout: "pipe",
      stderr: "pipe",
      // A cookie leaking in from the developer's shell would spend real
      // money from a unit test, so the environment is stated, not inherited.
      env: { ...process.env, CANARY_URL: "", CANARY_SESSION_COOKIE: "", ...env }
    }
  )
  const stdout = await new Response(child.stdout).text()
  const exitCode = await child.exited
  return { exitCode, stdout }
}

const runReport = async (
  extraArgs: ReadonlyArray<string>
): Promise<{ exitCode: number; stdout: string }> => {
  const child = Bun.spawn(["bun", join(scriptsDir, "uptime-report.ts"), ...extraArgs], {
    cwd: serverDir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GITHUB_OUTPUT: "" }
  })
  const stdout = await new Response(child.stdout).text()
  const exitCode = await child.exited
  return { exitCode, stdout }
}

describe("uptime-probe.ts against a live HTTP origin", () => {
  test("a healthy origin exits 0 and writes a report naming every check", async () => {
    mode = "healthy"
    const jsonPath = join(workDir, "healthy.json")
    const { exitCode, stdout } = await runProbe(["--samples", "5", "--json", jsonPath])

    expect(stdout).toContain("ok: every probed endpoint answered")
    expect(stdout).toContain("ok: probe-request error rate — 0/15 probe request(s) failed")
    expect(stdout).toContain("CANARY UPTIME PROBE PASS")
    expect(exitCode).toBe(0)

    const report = JSON.parse(readFileSync(jsonPath, "utf8")) as ProbeReport
    expect(report.origin).toBe(origin())
    expect(report.failed).toBe(false)
    expect(report.samples).toHaveLength(15)
    expect(report.meteredTurns).toBe(0)
  })

  test("without $CANARY_SESSION_COOKIE it says the turn seam was not measured, and spends nothing", async () => {
    mode = "healthy"
    const { stdout } = await runProbe(["--samples", "1"])
    expect(stdout).toContain("skip: turn-seam first-frame latency")
    expect(stdout).toContain("$CANARY_SESSION_COOKIE is unset")
    expect(stdout).toContain("0 metered turn(s) spent")
  })

  test("with a session cookie it takes exactly one metered turn and times the first frame", async () => {
    mode = "healthy"
    const jsonPath = join(workDir, "metered.json")
    const { exitCode, stdout } = await runProbe(["--samples", "1", "--json", jsonPath], {
      CANARY_SESSION_COOKIE: "smithers_session=probe"
    })

    expect(stdout).toContain("ok: turn-seam first-frame latency")
    expect(stdout).toContain("1 metered turn(s) spent")
    expect(exitCode).toBe(0)

    const report = JSON.parse(readFileSync(jsonPath, "utf8")) as ProbeReport
    expect(report.meteredTurns).toBe(1)
    expect(report.samples.filter((s) => s.label === "turn-first-frame")).toHaveLength(1)
  })

  test("--no-turn suppresses the metered turn even when the cookie is set", async () => {
    mode = "healthy"
    const { stdout } = await runProbe(["--samples", "1", "--no-turn"], {
      CANARY_SESSION_COOKIE: "smithers_session=probe"
    })
    expect(stdout).toContain("0 metered turn(s) spent")
    expect(stdout).toContain("skip: turn-seam first-frame latency")
  })

  test("a 5xx from the SPA fails uptime and the error rate, and exits 1", async () => {
    mode = "spa-down"
    const jsonPath = join(workDir, "down.json")
    const { exitCode, stdout } = await runProbe(["--samples", "5", "--json", jsonPath])

    expect(stdout).toContain("FAIL: every probed endpoint answered")
    expect(stdout).toContain("fully down: spa")
    expect(stdout).toContain("FAIL: probe-request error rate")
    expect(stdout).toContain("CANARY UPTIME PROBE FAILED")
    expect(exitCode).toBe(1)

    const report = JSON.parse(readFileSync(jsonPath, "utf8")) as ProbeReport
    expect(report.failed).toBe(true)
    expect(report.errorRate).toBeCloseTo(5 / 15, 10)
  })

  test("a turn seam that answers 200 to an anonymous caller fails the probe", async () => {
    mode = "turn-open"
    const { exitCode, stdout } = await runProbe(["--samples", "5"])
    expect(stdout).toContain("turn-gate (HTTP 200, expected 401)")
    expect(exitCode).toBe(1)
  })

  test("a nonsense --samples value is refused rather than silently defaulted", async () => {
    mode = "healthy"
    const { exitCode } = await runProbe(["--samples", "zero"])
    expect(exitCode).toBe(2)
  })
})

describe("uptime-report.ts", () => {
  const runUrl = "https://github.com/smithersai/flows/actions/runs/7"

  test("a failing report with nothing open asks for the issue to be created", async () => {
    mode = "spa-down"
    const jsonPath = join(workDir, "alert-fail.json")
    await runProbe(["--samples", "5", "--json", jsonPath])

    const outputPath = join(workDir, "output-create.txt")
    const bodyPath = join(workDir, "body-create.md")
    const { exitCode, stdout } = await runReport([
      "--report",
      jsonPath,
      "--run-url",
      runUrl,
      "--body-out",
      bodyPath,
      "--github-output",
      outputPath
    ])

    expect(stdout).toContain("alert: create")
    expect(exitCode).toBe(1)
    const output = readFileSync(outputPath, "utf8")
    expect(output).toContain("action=create")
    expect(output).toContain("issue=\n")
    expect(output).toContain(`title=${ALERT_TITLE}`)
    const body = readFileSync(bodyPath, "utf8")
    expect(body).toContain(`Run: ${runUrl}`)
    expect(body).toContain("| FAIL | every probed endpoint answered |")
  })

  test("a failing report with an issue open comments on it instead of opening a second", async () => {
    mode = "spa-down"
    const jsonPath = join(workDir, "alert-fail-2.json")
    await runProbe(["--samples", "5", "--json", jsonPath])

    const outputPath = join(workDir, "output-comment.txt")
    const { exitCode, stdout } = await runReport([
      "--report",
      jsonPath,
      "--open-issue",
      "31",
      "--github-output",
      outputPath
    ])

    expect(stdout).toContain("alert: comment on issue #31")
    expect(exitCode).toBe(1)
    expect(readFileSync(outputPath, "utf8")).toContain("action=comment\nissue=31\n")
  })

  test("a passing report closes the open issue and exits 0", async () => {
    mode = "healthy"
    const jsonPath = join(workDir, "alert-pass.json")
    await runProbe(["--samples", "5", "--json", jsonPath])

    const outputPath = join(workDir, "output-close.txt")
    const bodyPath = join(workDir, "body-close.md")
    const { exitCode, stdout } = await runReport([
      "--report",
      jsonPath,
      "--open-issue",
      "31",
      "--body-out",
      bodyPath,
      "--github-output",
      outputPath
    ])

    expect(stdout).toContain("alert: close on issue #31")
    expect(exitCode).toBe(0)
    expect(readFileSync(outputPath, "utf8")).toContain("action=close\nissue=31\n")
    expect(readFileSync(bodyPath, "utf8")).toStartWith("The canary recovered.")
  })

  test("a passing report with nothing open does nothing and exits 0", async () => {
    mode = "healthy"
    const jsonPath = join(workDir, "alert-pass-2.json")
    await runProbe(["--samples", "5", "--json", jsonPath])

    const outputPath = join(workDir, "output-none.txt")
    const { exitCode, stdout } = await runReport(["--report", jsonPath, "--github-output", outputPath])

    expect(stdout).toContain("alert: none")
    expect(exitCode).toBe(0)
    expect(readFileSync(outputPath, "utf8")).toContain("action=none")
  })

  test("a probe that never wrote a report still alerts, and never reports success", async () => {
    const outputPath = join(workDir, "output-missing.txt")
    const bodyPath = join(workDir, "body-missing.md")
    const { exitCode, stdout } = await runReport([
      "--report",
      join(workDir, "does-not-exist.json"),
      "--body-out",
      bodyPath,
      "--github-output",
      outputPath
    ])

    expect(stdout).toContain("alert: create")
    expect(exitCode).toBe(1)
    expect(readFileSync(bodyPath, "utf8")).toContain("proved nothing about the deployment")
  })

  test("--report is required", async () => {
    const { exitCode } = await runReport([])
    expect(exitCode).toBe(2)
  })
})
