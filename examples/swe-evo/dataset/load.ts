/**
 * SWE-EVO dataset loader.
 *
 * Downloads the 48 SWE-EVO task instances from the public HuggingFace dataset
 * (Fsoft-AIC/SWE-EVO, Apache-2.0, ~7.75 MB of text — the heavy Docker images are
 * pulled separately at scoring time) and materializes:
 *
 *   data/instances/<instance_id>.json  full instance (incl. gold patch) — used
 *                                      ONLY by the offline gold reference check
 *   data/gold/<instance_id>.patch      the gold solution diff (never enters a run)
 *   data/cases.jsonl                   smithers eval suite: one case per instance.
 *                                      The case input is the instance WITHOUT the
 *                                      gold patch, so the solution can never leak
 *                                      into a workflow run.
 *
 * Pass instance ids / repo names as args to filter (default: all 48).
 *   bun load.ts                         # all
 *   bun load.ts iterative/dvc           # one repo
 *   bun load.ts iterative__dvc_1.6.3_1.6.4
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, "data");
const ROWS_URL =
  "https://datasets-server.huggingface.co/rows?dataset=Fsoft-AIC/SWE-EVO&config=default&split=test&offset=0&length=100";

type Instance = Record<string, unknown> & {
  instance_id: string;
  repo: string;
  patch: string;
};

async function fetchRows(): Promise<Instance[]> {
  const res = await fetch(ROWS_URL);
  if (!res.ok) throw new Error(`HF rows fetch failed: ${res.status} ${res.statusText}`);
  const body = (await res.json()) as { rows: { row: Instance }[] };
  return body.rows.map((r) => r.row);
}

function matches(inst: Instance, filters: string[]): boolean {
  if (filters.length === 0) return true;
  return filters.some((f) => inst.instance_id === f || inst.repo === f);
}

async function main() {
  const filters = process.argv.slice(2);
  const rows = await fetchRows();
  mkdirSync(join(DATA, "instances"), { recursive: true });
  mkdirSync(join(DATA, "gold"), { recursive: true });

  const cases: string[] = [];
  let kept = 0;
  for (const inst of rows) {
    if (!matches(inst, filters)) continue;
    kept++;
    writeFileSync(
      join(DATA, "instances", `${inst.instance_id}.json`),
      JSON.stringify(inst, null, 2),
    );
    writeFileSync(join(DATA, "gold", `${inst.instance_id}.patch`), inst.patch ?? "");

    // The run NEVER sees the gold patch.
    const { patch: _gold, ...caseInput } = inst;
    cases.push(
      JSON.stringify({
        id: inst.instance_id,
        input: caseInput,
        expected: { status: "finished" },
        annotations: {
          repo: inst.repo,
          f2p: (inst.FAIL_TO_PASS as unknown[]).length,
          p2p: (inst.PASS_TO_PASS as unknown[]).length,
        },
      }),
    );
  }

  writeFileSync(join(DATA, "cases.jsonl"), cases.join("\n") + "\n");
  console.log(`Loaded ${kept}/${rows.length} instances → ${join(DATA, "cases.jsonl")}`);
  if (filters.length) console.log(`Filters: ${filters.join(", ")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
