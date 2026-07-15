import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, symlinkSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { createTempRepo, runSmithers } from "../../../packages/smithers/tests/e2e-helpers.js";

const ROOT = resolve(import.meta.dir, "../../..");
const BUNDLE_FIXTURE = resolve(import.meta.dir, "fixtures/bundle-gateway-ui-entries.js");
const UI_BUNDLE_BATCH_SIZE = 5;
const FORMER = ["vcs","implement","research-plan-implement","review","plan","research","ticket-create","tickets-create","ralph","improve-test-coverage","debug","grill-me","feature-enum","audit","mission","workflow-skill","kanban","hello","context-engineer","route-task","extract-skill","triage-run","context-doctor","backpressure-plan","eval-author","report-slideshow","smithering","delegation-chain","make-workflow-tutorial"];

test("former init workflows remain represented as documented copyable examples", () => {
  const inventory = readFileSync(resolve(ROOT, "examples/init-pack/README.md"), "utf8");
  for (const id of FORMER) {
    const example = resolve(ROOT, "examples/init-pack", `${id}.tsx`);
    expect(existsSync(example), `${id} lost its example`).toBe(true);
    const source = readFileSync(example, "utf8");
    expect(source.startsWith("// Example only:")).toBe(true);
    expect(source).not.toContain(`export { default } from "../../.smithers/workflows/${id}.tsx"`);
    expect(source).toContain("curated init pack");
    expect(source).toContain("smithers graph examples/init-pack/");
    expect(inventory).toContain(`| ${id} |`);

    // The archive is self-contained under examples/: every relative source
    // import must resolve without reaching into the curated installed pack.
    for (const match of source.matchAll(/(?:from|import\s*\()\s*["'](\.[^"']+)["']/g)) {
      const specifier = match[1];
      const base = resolve(dirname(example), specifier);
      const candidates = [base, `${base}.tsx`, `${base}.ts`, `${base}.jsx`, `${base}.js`, resolve(base, "index.tsx"), resolve(base, "index.ts")];
      expect(candidates.some((candidate) => existsSync(candidate)), `${id}: unresolved archive import ${specifier}`).toBe(true);
    }
  }
});

test("the archive documents a workflow-specific copy and graph command for every example", () => {
  for (const id of FORMER) {
    const source = readFileSync(resolve(ROOT, "examples/init-pack", `${id}.tsx`), "utf8");
    const header = source.split(/\r?\n/).slice(0, 5).join("\n");
    expect(header).toContain(`// Example only: ${id}`);
    expect(header).toContain(`examples/init-pack/${id}.tsx`);
    expect(header).not.toContain("copying its imports");
  }
});

/**
 * A temp repo with a REAL symlink to this checkout's examples/ tree (not a
 * copy — the transitive closure asserted above lives at examples/agents,
 * examples/prompts, examples/components, examples/ui and must stay reachable
 * exactly as a user who copies examples/init-pack/<id>.tsx would find it).
 */
function tempRepoWithExamples() {
  const repo = createTempRepo();
  symlinkSync(resolve(ROOT, "examples"), repo.path("examples"), "dir");
  return repo;
}

test(
  "every former init workflow's graph loads for real via the CLI graph loader",
  () => {
    const repo = tempRepoWithExamples();
    const failures = [];
    for (const id of FORMER) {
      const result = runSmithers(
        ["graph", `examples/init-pack/${id}.tsx`, "--run-id", "examples-init-pack-graph-check"],
        { cwd: repo.dir, format: "json", timeoutMs: 30_000 },
      );
      if (result.exitCode !== 0) {
        failures.push(`${id}: exit=${result.exitCode} ${result.stderr.slice(-500)}`);
      }
    }
    expect(failures).toEqual([]);
  },
  180_000,
);

test(
  "every former init workflow's declared UI bundles for real (compiled, not mocked)",
  () => {
    // The real Gateway UI bundler (packages/server/src/gatewayUi/bundle.js) —
    // the same Bun.build path the live gateway uses to serve each workflow's
    // <UI>, including its workspace-package resolution for @tanstack/* and
    // smithers-orchestrator/gateway-react. A hand-rolled Bun.build call here
    // would miss that resolution and false-fail on every UI.
    // Run bounded batches in clean Bun children. Bun's in-process test module
    // graph may already contain another workflow UI, and one child retaining
    // every compiled bundle can exhaust Bun's compiler memory on Linux.
    const entries = [];
    for (const id of FORMER) {
      const source = readFileSync(resolve(ROOT, "examples/init-pack", `${id}.tsx`), "utf8");
      const uiMatch = source.match(/<UI entry="(\.\.\/ui\/[^"]+)"/);
      expect(uiMatch, `${id}: no <UI entry=...> declaration to prove UI closure for`).toBeTruthy();
      const uiEntry = resolve(ROOT, "examples/init-pack", uiMatch[1]);
      expect(existsSync(uiEntry), `${id}: declared UI entry ${uiMatch[1]} is missing from examples/ui`).toBe(true);
      entries.push(uiEntry);
    }
    const result = [];
    const failures = [];
    for (let offset = 0; offset < entries.length; offset += UI_BUNDLE_BATCH_SIZE) {
      const batch = entries.slice(offset, offset + UI_BUNDLE_BATCH_SIZE);
      const batchNames = batch.map((entry) => relative(ROOT, entry));
      const bundled = spawnSync(process.execPath, ["run", BUNDLE_FIXTURE, JSON.stringify(batch)], {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 60_000,
      });
      if (bundled.status !== 0) {
        const output = bundled.stderr || bundled.error?.message || bundled.stdout || "no child output";
        failures.push(
          `Gateway UI bundle child failed for ${batchNames.join(", ")} ` +
          `(status=${String(bundled.status)}, signal=${String(bundled.signal)})\n${output.slice(-4_000)}`,
        );
        continue;
      }
      try {
        const batchResult = JSON.parse(bundled.stdout);
        if (!Array.isArray(batchResult)) {
          throw new TypeError("bundle fixture returned a non-array result");
        }
        result.push(...batchResult);
      }
      catch (error) {
        failures.push(`Gateway UI bundle child returned invalid JSON for ${batchNames.join(", ")}: ${String(error)}`);
      }
    }
    expect(failures, failures.join("\n\n")).toEqual([]);
    expect(result.map((entry) => entry.entry)).toEqual(entries);
    expect(result.every((entry) => entry.bytes > 0)).toBe(true);
  },
  120_000,
);
