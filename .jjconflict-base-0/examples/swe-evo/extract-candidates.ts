/**
 * Extract agent-generated candidate patches from the panel run DB.
 *
 * The panel's `diff` node captures the agents' edits as a unified patch and stores
 * it in the `diff` table (keyed by run_id = `sweevo-<instance_id>-<timestamp>`).
 * For instances that can't be scored on this host (env-incompatible Docker), the
 * candidate is still captured — pull it out here and write it to
 * `.data/candidates/<id>.patch` so score-x86.ts can score it on native x86.
 *
 *   bun extract-candidates.ts --subset <file>   # extract latest diff per id
 *   bun extract-candidates.ts <id>...
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, ".data");
const DB = join(DATA, "swe-evo-panel.db");
const CANDIDATES = join(DATA, "candidates");

function ids(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--subset") {
      out.push(
        ...readFileSync(argv[++i], "utf8")
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith("#")),
      );
    } else out.push(argv[i]);
  }
  if (out.length === 0) throw new Error("Select: <id>... or --subset <file>");
  return out;
}

function main() {
  const want = ids(process.argv.slice(2));
  if (!existsSync(DB)) throw new Error(`no panel DB at ${DB}`);
  mkdirSync(CANDIDATES, { recursive: true });
  const db = new Database(DB, { readonly: true });
  // latest diff per instance: run_id is `sweevo-<id>-<ms>`, so DESC string sort
  // on the fixed-width trailing timestamp is newest-first.
  const q = db.query(
    "SELECT patch FROM diff WHERE node_id='diff' AND run_id LIKE ? ORDER BY run_id DESC LIMIT 1",
  );
  let wrote = 0;
  const missing: string[] = [];
  for (const id of want) {
    const row = q.get(`sweevo-${id}-%`) as { patch: string } | null;
    if (!row || !row.patch) {
      missing.push(id);
      continue;
    }
    writeFileSync(join(CANDIDATES, `${id}.patch`), row.patch);
    console.log(`  ${id}: ${row.patch.length} chars -> candidates/${id}.patch`);
    wrote++;
  }
  db.close();
  console.log(`[extract] wrote ${wrote}/${want.length} candidate patch(es) to ${CANDIDATES}`);
  if (missing.length) console.log(`[extract] no diff yet for: ${missing.join(", ")}`);
}

main();
