#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { config } from "../src/config.js";

/**
 * Download the SWE-Bench Pro public test split (731 rows) to the normalized
 * JSONL the harness reads. Pure Node — uses the HuggingFace datasets-server
 * rows API and keeps every field's value verbatim (the list-typed columns stay
 * as their original string literals, which the scorer decodes the same way the
 * canonical evaluator does).
 */
async function main() {
  const dataset = encodeURIComponent(config.upstream.dataset);
  const split = config.upstream.datasetSplit;
  const base = `https://datasets-server.huggingface.co/rows?dataset=${dataset}&config=default&split=${split}`;
  const pageSize = 100;

  // First request to learn the row count.
  const head = await (await fetch(`${base}&offset=0&length=1`)).json();
  const total = head.num_rows_total ?? head.num_rows ?? 731;
  console.log(`[fetch] ${config.upstream.dataset}:${split} — ${total} rows`);

  const lines = [];
  for (let offset = 0; offset < total; offset += pageSize) {
    const url = `${base}&offset=${offset}&length=${pageSize}`;
    const json = await (await fetch(url)).json();
    for (const r of json.rows ?? []) lines.push(JSON.stringify(r.row));
    process.stdout.write(`\r[fetch] ${Math.min(offset + pageSize, total)}/${total}`);
  }
  process.stdout.write("\n");

  mkdirSync(dirname(config.datasetPath), { recursive: true });
  writeFileSync(config.datasetPath, lines.join("\n") + "\n");
  console.log(`[fetch] wrote ${lines.length} rows → ${config.datasetPath}`);
}

main().catch((err) => {
  console.error(err?.stack ?? String(err));
  process.exit(1);
});
