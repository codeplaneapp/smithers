// The ui-functional verifier's engine. Given a candidate's custom workflow UI
// bundle (.tsx), it PROVES the UI actually works by driving it in a real
// browser against a real Smithers run — no mocks, no route fabrication:
//
//   1. Seed a throwaway workspace (node_modules symlinks, no `smithers init`).
//   2. Install the candidate as .smithers/ui/ui-eval-fixture.tsx and the
//      deterministic fixture workflow beside it.
//   3. Run the fixture for real → it parks `waiting-approval` with a failed node,
//      three produced nodes, and a pending gate.
//   4. Boot a bespoke Gateway that mounts ONLY the fixture + candidate UI.
//   5. Load the UI in headless Chromium and assert observed behavior:
//      mounts, shows status, streams events from every task, renders node
//      output, surfaces the failed node, exposes an approval control — and (the
//      live proof) clicking Approve resumes the run to `finished`.
//
// It prints a JSON verdict to --out. Zero model spend; this is the deterministic
// hard gate that pairs with the ui-quality judge (which grades polish).
//
// Usage: bun evals/lib/ui-functional-runner.ts --artifact <file> --out <file>
//        [--required mounts,status,events,output,error,approval,approvalLive]
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FIXTURE } from "./ui-fixture/workflow.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const ROOT_NM = join(REPO_ROOT, "node_modules");
const CLI_ENTRY = join(REPO_ROOT, "apps/cli/src/index.js");
const BUN_DIR = dirname(process.execPath);
const KEY = FIXTURE.key;

type CheckName = "mounts" | "status" | "events" | "output" | "error" | "approval" | "approvalLive";
const ALL_CHECKS: CheckName[] = ["mounts", "status", "events", "output", "error", "approval", "approvalLive"];

type Check = { name: string; passed: boolean; detail: string };
type Verdict = {
  passed: boolean;
  score: number;
  reason: string;
  method: "ui-functional";
  checks: Check[];
  renderedText: string;
  features: Record<string, boolean>;
  infraError: string | null;
};

function parseArgs(argv: string[]): { artifact: string; out: string; required: CheckName[]; keepScreenshot?: string } {
  const m = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) m.set(argv[i]?.replace(/^--/, ""), argv[i + 1] ?? "");
  const required = (m.get("required") ?? "mounts,status,events,output,error,approval,approvalLive")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as CheckName[];
  return { artifact: m.get("artifact") ?? "", out: m.get("out") ?? "", required, keepScreenshot: m.get("screenshot") };
}

function link(target: string, path: string) {
  if (existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true });
  try {
    symlinkSync(target, path);
  } catch {
    /* concurrent create is fine */
  }
}

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => res(port));
    });
  });
}

async function waitHealth(base: string, ms = 60_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      if ((await fetch(`${base}/health`)).ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/** Resolve the Chromium playwright installed as an apps/cli devDependency. */
function resolveChromium(): { chromium: any } | null {
  try {
    const require = createRequire(join(REPO_ROOT, "apps/cli/package.json"));
    const chromium = require("playwright").chromium;
    const exe = chromium?.executablePath?.();
    if (typeof exe === "string" && existsSync(exe)) return { chromium };
  } catch {
    /* fall through */
  }
  return null;
}

function seedWorkspace(artifactSource: string): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(join(tmpdir(), "ui-functional-"));
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "ui-eval-fixture-ws", private: true, type: "module" }, null, 2)}\n`);
  const nm = join(dir, "node_modules");
  link(join(REPO_ROOT, "packages/smithers"), join(nm, "smthrs"));
  for (const d of ["zod", "react", "react-dom", "typescript", "@types", "@mdx-js"]) {
    link(join(ROOT_NM, d), join(nm, d));
  }
  mkdirSync(join(dir, ".smithers/workflows"), { recursive: true });
  mkdirSync(join(dir, ".smithers/ui"), { recursive: true });
  copyFileSync(join(HERE, "ui-fixture/workflow.tsx"), join(dir, ".smithers/workflows", `${KEY}.tsx`));
  copyFileSync(artifactSource, join(dir, ".smithers/ui", `${KEY}.tsx`));
  writeFileSync(
    join(dir, ".smithers/gateway.ts"),
    [
      'import { Gateway, mdxPlugin } from "smthrs";',
      'import { dirname, resolve } from "node:path";',
      'import { fileURLToPath } from "node:url";',
      "mdxPlugin();",
      "const here = dirname(fileURLToPath(import.meta.url));",
      'process.chdir(resolve(here, ".."));',
      'const port = Number(process.env.PORT ?? "7331");',
      'const host = process.env.HOST ?? "127.0.0.1";',
      "const gateway = new Gateway({ heartbeatMs: 15_000 });",
      `const mod = await import("./workflows/${KEY}.tsx");`,
      `gateway.register(${JSON.stringify(KEY)}, mod.default, {`,
      `  ui: { entry: resolve(here, "ui", ${JSON.stringify(`${KEY}.tsx`)}), title: "UI Eval Fixture" },`,
      `  entryFile: resolve(here, "workflows", ${JSON.stringify(`${KEY}.tsx`)}),`,
      "});",
      "await gateway.listen({ host, port });",
      'console.log("GATEWAY_LISTENING " + port);',
      "",
    ].join("\n"),
  );
  // A stub agent on PATH (the fixture is all compute tasks, but the CLI probes
  // for an installed agent at startup).
  const binDir = join(dir, ".fakebin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "claude"), `#!/bin/sh\necho '{"summary":"ok"}'\n`);
  chmodSync(join(binDir, "claude"), 0o755);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: dir,
    PATH: `${binDir}:${BUN_DIR}:/usr/bin:/bin:/usr/sbin:/sbin`,
    ANTHROPIC_API_KEY: "",
    OPENAI_API_KEY: "",
    NO_COLOR: "1",
  };
  return { dir, env };
}

function runFixture(dir: string, env: NodeJS.ProcessEnv): { runId: string | null; status: string | null; detail: string } {
  const r = spawnSync("bun", ["run", CLI_ENTRY, "up", `.smithers/workflows/${KEY}.tsx`, "--format", "json"], {
    cwd: dir,
    env,
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const stdout = (r.stdout ?? "").trim();
  let json: any;
  try {
    const start = stdout.lastIndexOf("\n{");
    json = JSON.parse(start >= 0 ? stdout.slice(start + 1) : stdout);
  } catch {
    /* no json */
  }
  const detail = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.split("\n").slice(-12).join(" ").slice(0, 800);
  return { runId: typeof json?.runId === "string" ? json.runId : null, status: json?.status ?? null, detail };
}

/** The browser assertions. Returns every check + the observed DOM text. */
async function driveBrowser(
  chromium: any,
  base: string,
  runId: string,
): Promise<{ checks: Record<CheckName, Check>; renderedText: string; screenshot: Buffer | null }> {
  const url = `${base}/workflows/${KEY}?runId=${runId}`;
  const browser = await chromium.launch({ headless: true });
  const pageErrors: string[] = [];
  const mk = (name: CheckName, passed: boolean, detail: string): Check => ({ name, passed, detail });
  const checks = {} as Record<CheckName, Check>;
  let renderedText = "";
  let screenshot: Buffer | null = null;
  try {
    const page = await browser.newPage();
    page.on("pageerror", (e: Error) => pageErrors.push(e.message));
    await page.goto(url, { waitUntil: "domcontentloaded" });

    // mounts — the bundle built, imported, and React mounted real content.
    let mounted = false;
    try {
      await page.waitForFunction(() => (document.body.textContent ?? "").trim().length > 10, { timeout: 25_000 });
      mounted = true;
    } catch {
      /* stays false */
    }
    checks.mounts = mk(
      "mounts",
      mounted && pageErrors.length === 0,
      mounted ? (pageErrors.length ? `pageerror: ${pageErrors[0].slice(0, 200)}` : "mounted") : "no content mounted",
    );

    // Give live hooks a beat to fetch run/output and drain the event stream.
    const readText = async () => ((await page.evaluate(() => document.body.innerText)) ?? "").toString();
    for (let i = 0; i < 20; i++) {
      renderedText = await readText();
      const lower = renderedText.toLowerCase();
      if (lower.includes("waiting-approval") && renderedText.includes(FIXTURE.reportHeadline)) break;
      await page.waitForTimeout(500);
    }
    const lower = () => renderedText.toLowerCase();

    // status — the UI read the run and shows its live status.
    checks.status = mk(
      "status",
      lower().includes("waiting-approval") || lower().includes("waiting approval"),
      lower().includes("waiting") ? "shows run status" : "run status not shown",
    );

    // events — the live event stream surfaced every healthy task's node.
    const healthy = ["plan", "build", "report"];
    const shownNodes = healthy.filter((n) => new RegExp(`\\b${n}\\b`).test(lower()));
    checks.events = mk(
      "events",
      shownNodes.length === healthy.length,
      `event stream shows nodes: ${shownNodes.join(",") || "none"} (need plan+build+report)`,
    );

    // output — the UI read + rendered the 'report' node's real output.
    const hasOutput = renderedText.includes(FIXTURE.reportHeadline) && lower().includes(FIXTURE.reportText.toLowerCase());
    checks.output = mk("output", hasOutput, hasOutput ? "renders report node output" : "report node output missing");

    // error — the failed node is surfaced (message or a failed/error marker on it).
    const hasErr =
      lower().includes("intentional failure") ||
      (lower().includes("flaky") && (lower().includes("fail") || lower().includes("error")));
    checks.error = mk("error", hasErr, hasErr ? "surfaces failed node" : "failed node not surfaced");

    // approval — an actionable approve control exists.
    const approveBtn = page
      .locator('button:has-text("Approve"), [role="button"]:has-text("Approve"), button:has-text("approve")')
      .first();
    let hasApprove = false;
    try {
      hasApprove = (await approveBtn.count()) > 0;
    } catch {
      /* none */
    }
    checks.approval = mk("approval", hasApprove, hasApprove ? "approve control present" : "no approve control");

    // approvalLive — clicking Approve actually resumes the run to `finished`
    // (proves live writes via useGatewayActions + the live status update flowing
    // back into the UI). Verified through the UI's own rendered status, so it
    // exercises exactly the path a user sees.
    let resumed = false;
    let liveDetail = "approve control not clickable";
    if (hasApprove) {
      try {
        await approveBtn.click({ timeout: 5_000 });
        for (let i = 0; i < 30; i++) {
          await page.waitForTimeout(1_000);
          const t = (await readText()).toLowerCase();
          if (t.includes("finished")) {
            resumed = true;
            liveDetail = "approve resumed run to finished (live)";
            renderedText = await readText();
            break;
          }
          if (t.includes("cancelled") || t.includes("failed") && !t.includes("intentional")) {
            liveDetail = "run did not finish after approve";
            break;
          }
          liveDetail = "run did not reach finished after approve";
        }
      } catch (e) {
        liveDetail = `approve click failed: ${(e as Error).message.slice(0, 160)}`;
      }
    }
    checks.approvalLive = mk("approvalLive", resumed, liveDetail);

    try {
      screenshot = await page.screenshot({ fullPage: true });
    } catch {
      /* screenshot best-effort */
    }
  } finally {
    try {
      await browser.close();
    } catch {
      /* ignore */
    }
  }
  return { checks, renderedText, screenshot };
}

function fail(reason: string): Verdict {
  return {
    passed: false,
    score: 0,
    reason,
    method: "ui-functional",
    checks: [{ name: "infra", passed: false, detail: reason }],
    renderedText: "",
    features: {},
    infraError: reason,
  };
}

async function main() {
  const { artifact, out, required, keepScreenshot } = parseArgs(process.argv.slice(2));
  if (!artifact || !existsSync(artifact)) {
    writeFileSync(out || "/dev/stdout", JSON.stringify(fail(`artifact file missing: ${artifact}`)));
    process.exit(0);
  }

  const chromiumMod = resolveChromium();
  if (!chromiumMod) {
    // No browser (e.g. CI without Chromium) — cannot functionally verify. Emit a
    // skip verdict so the caller can decide (the eval harness skips, not fails).
    const v = fail("SKIP: playwright Chromium not installed");
    v.features = { skipped: true };
    writeFileSync(out || "/dev/stdout", JSON.stringify(v));
    process.exit(0);
  }

  const { dir, env } = seedWorkspace(artifact);
  let gatewayProc: ReturnType<typeof spawn> | null = null;
  try {
    const fixture = runFixture(dir, env);
    if (fixture.status !== "waiting-approval" || !fixture.runId) {
      // The fixture itself did not reach the expected state — infra, not the
      // candidate. Surface it loudly so a broken harness never silently fails
      // every candidate.
      const v = fail(`fixture did not park waiting-approval (status=${fixture.status}): ${fixture.detail}`);
      writeFileSync(out || "/dev/stdout", JSON.stringify(v));
      return;
    }

    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    gatewayProc = spawn("bun", ["run", ".smithers/gateway.ts"], {
      cwd: dir,
      env: { ...env, PORT: String(port), HOST: "127.0.0.1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let gwLog = "";
    gatewayProc.stdout?.on("data", (d) => (gwLog += d));
    gatewayProc.stderr?.on("data", (d) => (gwLog += d));

    if (!(await waitHealth(base))) {
      const v = fail(`gateway did not become healthy: ${gwLog.split("\n").slice(0, 8).join(" ").slice(0, 500)}`);
      writeFileSync(out || "/dev/stdout", JSON.stringify(v));
      return;
    }

    const { checks, renderedText, screenshot } = await driveBrowser(chromiumMod.chromium, base, fixture.runId);
    if (keepScreenshot && screenshot) {
      try {
        writeFileSync(keepScreenshot, screenshot);
      } catch {
        /* ignore */
      }
    }

    const checkList = ALL_CHECKS.map((n) => checks[n]).filter(Boolean);
    const features: Record<string, boolean> = {};
    for (const c of checkList) features[c.name] = c.passed;
    const requiredChecks = checkList.filter((c) => required.includes(c.name as CheckName));
    const passed = requiredChecks.length > 0 && requiredChecks.every((c) => c.passed);
    const score = checkList.length ? checkList.filter((c) => c.passed).length / checkList.length : 0;
    const failed = requiredChecks.filter((c) => !c.passed).map((c) => c.name);
    const verdict: Verdict = {
      passed,
      score,
      reason: passed
        ? `UI passed all ${requiredChecks.length} required functional checks`
        : `failed required checks: ${failed.join(", ")}`,
      method: "ui-functional",
      checks: checkList,
      renderedText: renderedText.slice(0, 4_000),
      features,
      infraError: null,
    };
    writeFileSync(out || "/dev/stdout", JSON.stringify(verdict));
  } catch (e) {
    writeFileSync(out || "/dev/stdout", JSON.stringify(fail(`runner crashed: ${(e as Error).message.slice(0, 400)}`)));
  } finally {
    try {
      gatewayProc?.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

void main();
