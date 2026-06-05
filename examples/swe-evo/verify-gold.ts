/**
 * Fairness gate: prove the harness reproduces the reference.
 *
 * For each selected instance, this applies the OFFICIAL gold patch and scores it
 * with the same hermetic harness the benchmark uses. A correct, non-fudged
 * harness must score the gold patch as resolved=1 / fix_rate=1.0 on every
 * instance whose Docker image runs cleanly in this environment. Any instance
 * where the gold patch does NOT reproduce resolved=1 is reported as
 * ENV-INCOMPATIBLE (e.g. tests that depend on host networking under emulation)
 * and should be excluded from benchmark runs in this environment — transparently,
 * never silently.
 *
 * Usage:
 *   bun verify-gold.ts <instance_id|repo>...   # specific
 *   bun verify-gold.ts --all                   # all 48
 *   bun verify-gold.ts iterative/dvc           # one repo
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scoreCandidate, type Instance } from "./workflow/harness.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, "dataset", "data");

function select(argv: string[]): Instance[] {
  const dir = join(DATA, "instances");
  if (!existsSync(dir)) throw new Error(`No dataset at ${dir}. Run: bun dataset/load.ts`);
  const all = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Instance);
  if (argv.includes("--all")) return all;
  const subIdx = argv.indexOf("--subset");
  const subsetFile = subIdx >= 0 ? argv[subIdx + 1] : undefined;
  const ids = argv.filter((a, i) => !a.startsWith("--") && i !== subIdx + 1);
  if (subsetFile) {
    ids.push(
      ...readFileSync(subsetFile, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#")),
    );
  }
  if (ids.length === 0) throw new Error("Select: <id|repo>..., --subset <file>, or --all");
  return all.filter((i) => ids.includes(i.instance_id) || ids.includes(i.repo));
}

async function main() {
  const argv = process.argv.slice(2);
  const instances = select(argv);
  const timeoutS = Number(process.env.SWEEVO_SCORE_TIMEOUT_S ?? 1800);
  const ok: string[] = [];
  const bad: { id: string; reason: string }[] = [];

  for (const inst of instances) {
    const goldPath = join(DATA, "gold", `${inst.instance_id}.patch`);
    const gold = readFileSync(goldPath, "utf8");
    process.stderr.write(`[verify] ${inst.instance_id} ... `);
    try {
      const s = scoreCandidate(inst, gold, timeoutS);
      const pass = s.resolved === 1 && s.fix_rate === 1;
      process.stderr.write(
        `${pass ? "OK" : "MISMATCH"} resolved=${s.resolved} fix=${s.fix_rate} ` +
          `F2P=${s.f2p_passed}/${s.f2p_total} P2P=${s.p2p_passed}/${s.p2p_total} (${s.duration_s}s)\n`,
      );
      if (pass) ok.push(inst.instance_id);
      else {
        const fails = Object.keys(s.p2p_failures).slice(0, 3).join(", ");
        bad.push({
          id: inst.instance_id,
          reason: `resolved=${s.resolved} F2P=${s.f2p_passed}/${s.f2p_total} P2P=${s.p2p_passed}/${s.p2p_total}` +
            (fails ? ` p2p_fail:[${fails}]` : ""),
        });
      }
    } catch (e: unknown) {
      process.stderr.write(`ERROR\n`);
      bad.push({ id: inst.instance_id, reason: (e as Error)?.message?.slice(0, 120) ?? "error" });
    }
  }

  console.log("\n================ GOLD REFERENCE CHECK ================");
  console.log(`reproduced (gold -> resolved=1): ${ok.length}/${instances.length}`);
  if (ok.length) console.log("  OK: " + ok.join("\n      "));
  if (bad.length) {
    console.log(`\nENV-INCOMPATIBLE / mismatched: ${bad.length}`);
    for (const b of bad) console.log(`  ✗ ${b.id} — ${b.reason}`);
    console.log(
      "\nThese should be excluded from benchmark runs in THIS environment\n" +
        "(they typically depend on host networking that differs under x86 emulation).",
    );
  }
  console.log("\nVerified-runnable subset (copy into a subset file):");
  console.log(ok.join("\n"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
