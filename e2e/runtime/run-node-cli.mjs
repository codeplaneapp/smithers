// End-to-end proof that the PUBLISHED packages run under plain Node with no
// Bun on PATH: pack every workspace package, npm-install the tarballs into a
// throwaway directory outside the repo, then drive the CLI there.
//
// A workspace link would hide the two failure classes this guards: source that
// only Bun can parse (`bun:sqlite`, `.tsx`, `.ts` under node_modules) and
// dependencies that resolve in the monorepo but are missing from a manifest.
//
// Usage: node e2e/runtime/run-node-cli.mjs
// Slow (packs ~54 tarballs and runs a real npm install), so it is its own
// script rather than part of `bun test`.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { overridesFor, packWorkspaceTarballs } from "../../scripts/pack-workspace-tarballs.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workspace = mkdtempSync(join(tmpdir(), "smithers-node-cli-"));
const tarballDir = join(workspace, "tarballs");
const project = join(workspace, "project");

// Node with no Bun anywhere on PATH. `spawn("bun", ...)` used to be hardcoded
// in the detached run launcher, and a PATH that still had Bun hid that.
const nodeBin = dirname(process.execPath);
const nodeOnlyPath = ["/usr/bin", "/bin", "/usr/sbin", "/sbin", nodeBin].join(":");
const env = { ...process.env, PATH: nodeOnlyPath, SMITHERS_BACKEND: "pglite" };
delete env.BUN_INSTALL;

const failures = [];

/** @param {number} ms */
function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

/** @param {string} name @param {() => unknown} body */
async function check(name, body) {
  try {
    await body();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`FAIL ${name}\n     ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * @param {string[]} args
 * @returns {{ status: number | null; stdout: string; stderr: string }}
 */
function smithers(args) {
  try {
    const stdout = execFileSync(process.execPath, [join(project, "node_modules/smthrs/src/bin/smithers.js"), ...args], {
      cwd: project,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    return { status: error.status ?? null, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? "") };
  }
}

/** @param {unknown} condition @param {string} message */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  console.log("packing workspace tarballs...");
  const tarballs = packWorkspaceTarballs(tarballDir, repoRoot);
  mkdirSync(project, { recursive: true });
  writeFileSync(
    join(project, "package.json"),
    `${JSON.stringify(
      {
        name: "smithers-node-runtime-consumer",
        version: "1.0.0",
        private: true,
        type: "module",
        dependencies: { smthrs: `file:${tarballs.smthrs}`, zod: "^4.4.3" },
        overrides: overridesFor(tarballs),
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(project, "tsconfig.json"),
    `${JSON.stringify({ compilerOptions: { jsx: "react-jsx", jsxImportSource: "smthrs", strict: true } }, null, 2)}\n`,
  );
  writeFileSync(
    join(project, "workflow.tsx"),
    `/** @jsxImportSource smthrs */
import { openSmithersBackend, Sequence, Task } from "smthrs";
import { z } from "zod";

const { Workflow, smithers, outputs } = await openSmithersBackend({
  input: z.object({ name: z.string() }),
  greeting: z.object({ message: z.string() }),
});

export default smithers((ctx) => (
  <Workflow name="hello-node">
    <Sequence>
      <Task id="greet" output={outputs.greeting}>
        {{ message: \`Hello, \${ctx.input.name}\` }}
      </Task>
    </Sequence>
  </Workflow>
));
`,
  );

  console.log("installing tarballs with npm...");
  execFileSync("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], {
    cwd: project,
    env,
    stdio: "inherit",
  });

  await check("effect resolves to exactly one copy", () => {
    const lock = JSON.parse(readFileSync(join(project, "package-lock.json"), "utf8"));
    const copies = Object.keys(lock.packages ?? {}).filter((path) => path.endsWith("node_modules/effect"));
    assert(copies.length === 1, `expected 1 effect copy, found ${copies.length}: ${copies.join(", ")}`);
  });

  await check("import('smthrs') succeeds under plain Node", () => {
    const output = execFileSync(process.execPath, ["-e", "import('smthrs').then(() => console.log('ok'))"], {
      cwd: project,
      env,
      encoding: "utf8",
    });
    assert(output.trim() === "ok", `unexpected output: ${output}`);
  });

  await check("the sqlite backend reports DB_REQUIRES_BUN_SQLITE", () => {
    const result = smithers(["up", "workflow.tsx", "--backend", "sqlite", "--input", '{"name":"node"}', "-d"]);
    const combined = result.stdout + result.stderr;
    assert(result.status !== 0, "expected a non-zero exit");
    assert(combined.includes("DB_REQUIRES_BUN_SQLITE"), `expected DB_REQUIRES_BUN_SQLITE, got: ${combined.slice(0, 400)}`);
    assert(combined.includes("SMITHERS_BACKEND=pglite"), "the error must name the pglite fix");
    assert(!combined.includes("ERR_UNSUPPORTED_ESM_URL_SCHEME"), "a loader crash leaked instead of the SmithersError");
  });

  let runId = "";
  await check("a .tsx workflow runs to completion on pglite", async () => {
    const started = smithers(["up", "workflow.tsx", "--input", '{"name":"node"}', "-d"]);
    assert(started.status === 0, `up failed: ${(started.stdout + started.stderr).slice(0, 800)}`);
    runId = started.stdout.match(/runId:\s*(\S+)/)?.[1] ?? "";
    assert(runId, `no runId in output: ${started.stdout.slice(0, 400)}`);
    const deadline = Date.now() + 120_000;
    let status = "";
    while (Date.now() < deadline) {
      const inspected = smithers(["inspect", runId, "--format", "json"]);
      status = JSON.parse(inspected.stdout || "{}")?.run?.status ?? "";
      if (status === "finished" || status === "failed") break;
      await sleep(1000);
    }
    assert(status === "finished", `run ended as ${status || "unknown"}`);
  });

  await check("smithers output returns the task row", () => {
    const output = smithers(["output", runId, "greet"]);
    assert(output.status === 0, `output failed: ${output.stderr.slice(0, 400)}`);
    assert(output.stdout.includes("Hello, node"), `unexpected output row: ${output.stdout.slice(0, 200)}`);
  });

  await check("the gateway boots, serves RPC, and lists the run", async () => {
    const gateway = spawn(process.execPath, [join(project, "node_modules/smthrs/src/bin/smithers.js"), "gateway"], {
      cwd: project,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      let log = "";
      const deadline = Date.now() + 90_000;
      gateway.stdout.on("data", (chunk) => (log += chunk));
      gateway.stderr.on("data", (chunk) => (log += chunk));
      let url = "";
      while (Date.now() < deadline && !url) {
        await sleep(500);
        url = log.match(/Gateway listening on (\S+)/)?.[1] ?? "";
      }
      assert(url, `gateway never reported a listening URL: ${log.slice(0, 600)}`);
      const rpc = execFileSync(
        "curl",
        ["-s", "-X", "POST", `${url}/rpc`, "-H", "content-type: application/json", "-d", '{"method":"listRuns","params":{}}'],
        { encoding: "utf8" },
      );
      assert(rpc.includes(runId), `listRuns did not include ${runId}: ${rpc.slice(0, 300)}`);
    } finally {
      gateway.kill("SIGTERM");
    }
  });
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\nNode runtime CLI conformance failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nNode runtime CLI conformance passed");
