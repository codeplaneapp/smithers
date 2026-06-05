#!/usr/bin/env node
import { loadInstances } from "../src/loadInstances.js";
import { runBenchmark } from "../src/runBenchmark.js";
import { runGatewayBenchmark } from "../src/runViaGateway.js";
import { validateHarness } from "../src/validateHarness.js";

/**
 * Tiny flag parser: `--key value`, `--flag`, repeatable values comma-split.
 * @param {string[]} argv
 */
function parseFlags(argv) {
  /** @type {Record<string, string | boolean>} */
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith("--")) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i++;
    }
  }
  return flags;
}

/** @param {string | boolean | undefined} v */
const list = (v) => (typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);
/** @param {string | boolean | undefined} v */
const num = (v) => (typeof v === "string" ? Number(v) : undefined);

const HELP = `swebp — SWE-Bench Pro benchmark for Smithers

Usage:
  swebp run     [selection] [model/timeout options]   Generate patches with Smithers and score them
  swebp verify  [selection]                           Only run the gold/empty integrity controls (no agent)
  swebp list    [selection]                           List matching instances

Selection:
  --ids a,b           Specific instance ids
  --repos a,b         Filter by repo (e.g. flipt-io/flipt)
  --languages go,py   Filter by repo language (go|py|js|ts)
  --limit N           Cap count

Run options:
  --implementer M     Implementer model (default claude-opus-4-8)
  --reviewer M        Reviewer model    (default gpt-5.5-codex)
  --skip-integrity    Skip gold/empty controls (faster, less rigorous)
  --agent-timeout-ms  Per-instance agent wall-clock cap
  --report PATH       Where to write the JSON report
  --gateway           Launch runs through the Smithers gateway RPC (boots a local
                      gateway server) instead of in-process \`smithers up\`
`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  const selection = {
    ids: list(flags.ids),
    repos: list(flags.repos),
    languages: list(flags.languages),
    limit: num(flags.limit),
  };
  const nowMs = Date.now();

  if (!cmd || cmd === "help" || flags.help) {
    console.log(HELP);
    return;
  }

  if (cmd === "list") {
    const instances = loadInstances(selection);
    for (const it of instances) {
      console.log(`${it.instanceId}\t${it.repo}\t${it.repoLanguage}\tf2p=${it.failToPass.length} p2p=${it.passToPass.length}`);
    }
    console.log(`\n${instances.length} instance(s)`);
    return;
  }

  if (cmd === "verify") {
    const instances = loadInstances(selection);
    if (!instances.length) throw new Error("no instances matched the selection");
    let valid = 0;
    for (const it of instances) {
      const r = await validateHarness(it, { log: (m) => console.log(m) });
      if (r.valid) valid++;
      console.log(`[verify] ${it.instanceId}: ${r.valid ? "SOUND" : "UNSOUND"} (gold=${r.goldResolved} empty=${r.emptyResolved})`);
    }
    console.log(`\n${valid}/${instances.length} instances have a sound, discriminating harness`);
    if (valid !== instances.length) process.exit(1);
    return;
  }

  if (cmd === "run") {
    const runner = flags.gateway === true ? runGatewayBenchmark : runBenchmark;
    await runner({
      ...selection,
      implementerModel: typeof flags.implementer === "string" ? flags.implementer : undefined,
      reviewerModel: typeof flags.reviewer === "string" ? flags.reviewer : undefined,
      skipIntegrity: flags["skip-integrity"] === true,
      agentTimeoutMs: num(flags["agent-timeout-ms"]),
      scoreTimeoutMs: num(flags["score-timeout-ms"]),
      reportPath: typeof flags.report === "string" ? flags.report : undefined,
      nowMs,
      log: (m) => console.log(m),
    });
    return;
  }

  console.error(`unknown command: ${cmd}\n`);
  console.log(HELP);
  process.exit(2);
}

main().catch((err) => {
  console.error(err?.stack ?? String(err));
  process.exit(1);
});
