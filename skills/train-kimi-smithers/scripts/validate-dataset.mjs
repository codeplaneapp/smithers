#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { gunzipSync } from "node:zlib";
import { validateRows } from "./prepare-dataset.mjs";

async function readRows(path) {
  const bytes = await readFile(path);
  const text = extname(path) === ".gz" ? gunzipSync(bytes).toString("utf8") : bytes.toString("utf8");
  const rows = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      throw new Error(`${path}:${index + 1}: invalid JSON: ${error.message}`);
    }
  }
  return rows;
}

async function main(paths) {
  if (!paths.length || paths.includes("--help") || paths.includes("-h")) {
    process.stdout.write("Usage: validate-dataset.mjs <train.jsonl[.gz]> [validation.jsonl[.gz] ...]\n");
    return;
  }
  const summaries = [];
  for (const path of paths) {
    const rows = await readRows(path);
    validateRows(rows, path);
    summaries.push({ path, rows: rows.length });
  }
  process.stdout.write(`${JSON.stringify({ valid: true, datasets: summaries }, null, 2)}\n`);
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
