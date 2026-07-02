import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { dddRoot } from "./dddRoot.ts";

/**
 * Prints the bounded set of files an auditor should read for a
 * docs-driven-development round, so audits do not wander the whole repo:
 * features.json, the editable overview + reference/derived content, the design
 * spec doc, the workflow source, the ddd scripts, and a listing of the latest
 * artifacts directory.
 */
const FIXED_INPUTS = [
  ".smithers/spec/features.json",
  ".smithers/spec/content/overview.md",
  ".smithers/specs/docs-driven-development.md",
  ".smithers/workflows/docs-driven-development.tsx",
];

const LISTED_DIRS = [
  ".smithers/spec/content/reference",
  ".smithers/spec/content/features",
  ".smithers/lib/ddd",
  ".smithers/docs-driven-development/artifacts",
];

export function collectAuditInputs(root: string = dddRoot()): string[] {
  const out: string[] = [];
  for (const rel of FIXED_INPUTS) {
    if (existsSync(resolve(root, rel))) out.push(rel);
  }
  for (const dir of LISTED_DIRS) {
    const full = resolve(root, dir);
    if (!existsSync(full) || !statSync(full).isDirectory()) continue;
    for (const entry of readdirSync(full).sort()) {
      const entryPath = resolve(full, entry);
      if (statSync(entryPath).isFile() && statSync(entryPath).size <= 256_000) {
        out.push(`${dir}/${entry}`);
      }
    }
  }
  return [...new Set(out)];
}

if (import.meta.main) {
  console.log(JSON.stringify({ files: collectAuditInputs() }, null, 2));
}
