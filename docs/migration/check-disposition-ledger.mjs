#!/usr/bin/env node
// Validates docs/migration/disposition-ledger.json (the A8 driver contract) against the trees it
// describes and against docs/migration/disposition-ledger.md.
//
//   node docs/migration/check-disposition-ledger.mjs [--allow-missing-trees]
//
// Checks:
//   1. `generatedFrom` equals `flowsHead`; every row's `disposition` is one of the six closed values
//      (replace, migrate, keep, delete, import) and no row is `decide`; `import` rows are flows-tree rows.
//   2. Every executable row (no `executable: false`) has `path`: a non-empty array of globs with no
//      spaces, `+`, brace ranges or absolute paths; flows-tree globs carry the `flows:` prefix and
//      old-tree globs do not; every glob matches at least one file (or gitlink) in
//      `git ls-tree -r --name-only <revision>` of its tree.
//   3. Every advisory row (`executable: false`) has a string `path` and a unique `key`; every `label`
//      is unique; every row has `section`, `tree`, `phase`, `newHome`, `rationale`.
//   4. The Markdown ledger holds the same number of table rows in its "## Ledger" section and the
//      same per-disposition counts as the JSON.
//
// A tree repository is resolved from `trees[name].environment` (an environment variable) when set,
// otherwise from `trees[name].repository`; `.` means the repository that contains this script. With
// --allow-missing-trees a tree whose repository is absent is reported and skipped. The per-file
// ownership check (most specific row wins, zero uncovered and zero ambiguous files) is the Phase 1/2
// driver's job: `ledger-driver.py check --ledger <this>.json --v1 . --flows-repo <flows>`.

import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const allowMissing = process.argv.includes("--allow-missing-trees");
const ledger = JSON.parse(readFileSync(path.join(here, "disposition-ledger.json"), "utf8"));
const markdown = readFileSync(path.join(here, "disposition-ledger.md"), "utf8");
const problems = [];
const DISPOSITIONS = ["replace", "migrate", "keep", "delete", "import"];

function braceExpand(glob) {
  const m = /\{([^{}]*)\}/.exec(glob);
  if (!m) return [glob];
  if (m[1].includes("..")) throw new Error(`brace range not allowed: ${glob}`);
  const pre = glob.slice(0, m.index);
  const post = glob.slice(m.index + m[0].length);
  return m[1].split(",").flatMap((alt) => braceExpand(pre + alt + post));
}

function globToRegExp(glob) {
  let source = "";
  for (let i = 0; i < glob.length;) {
    if (glob.startsWith("**/", i)) {
      source += "(?:.*/)?";
      i += 3;
    } else if (glob.startsWith("**", i)) {
      source += ".*";
      i += 2;
    } else if (glob[i] === "*") {
      source += "[^/]*";
      i += 1;
    } else if (glob[i] === "?") {
      source += "[^/]";
      i += 1;
    } else {
      source += glob[i].replace(/[.+?^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${source}(?:/.*)?$`);
}

const listings = new Map();
function listing(treeName) {
  if (listings.has(treeName)) return listings.get(treeName);
  const tree = ledger.trees[treeName];
  if (!tree) {
    problems.push(`unknown tree ${treeName}`);
    listings.set(treeName, null);
    return null;
  }
  const repo = (tree.environment && process.env[tree.environment]) || (tree.repository === "." ? path.resolve(here, "..", "..") : tree.repository);
  const revision = treeName === "flows" ? ledger.generatedFrom : tree.revision;
  if (!existsSync(repo)) {
    if (allowMissing) {
      console.log(`skip: tree ${treeName} (${repo}) is absent`);
      listings.set(treeName, null);
      return null;
    }
    problems.push(`tree ${treeName}: repository ${repo} is absent (use --allow-missing-trees to skip)`);
    listings.set(treeName, null);
    return null;
  }
  const out = execFileSync("git", ["-C", repo, "ls-tree", "-r", "--name-only", "--full-tree", revision], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const files = out.split("\n").filter(Boolean);
  listings.set(treeName, files);
  return files;
}

if (ledger.generatedFrom !== ledger.flowsHead) problems.push(`generatedFrom ${ledger.generatedFrom} differs from flowsHead ${ledger.flowsHead}`);
const labels = new Map();
const keys = new Map();
const counts = new Map();
for (const [index, row] of ledger.entries.entries()) {
  const id = `row ${index} (${String(row.label).slice(0, 60)})`;
  for (const field of ["label", "kind", "disposition", "newHome", "phase", "tree", "rationale", "section"]) {
    if (typeof row[field] !== "string") problems.push(`${id}: missing ${field}`);
  }
  counts.set(row.disposition, (counts.get(row.disposition) ?? 0) + 1);
  if (!DISPOSITIONS.includes(row.disposition)) problems.push(`${id}: disposition ${row.disposition} is not one of ${DISPOSITIONS.join(", ")}`);
  if (row.disposition === "import" && row.tree !== "flows") problems.push(`${id}: import rows must be flows-tree rows`);
  if (labels.has(row.label)) problems.push(`${id}: duplicate label (also row ${labels.get(row.label)})`);
  labels.set(row.label, index);
  const executable = row.executable !== false;
  if (!executable) {
    if (typeof row.path !== "string") problems.push(`${id}: advisory row must keep a descriptive string path`);
    if (typeof row.key !== "string" || !row.key) problems.push(`${id}: advisory row needs a key`);
    else if (keys.has(row.key)) problems.push(`${id}: duplicate key ${row.key} (also row ${keys.get(row.key)})`);
    keys.set(row.key, index);
    continue;
  }
  if (!Array.isArray(row.path) || row.path.length === 0) {
    problems.push(`${id}: executable row needs a non-empty path array`);
    continue;
  }
  if (row.disposition === "import" && row.tree !== "flows") continue;
  for (const glob of row.path) {
    if (typeof glob !== "string" || glob.includes(" ") || glob.includes("+") || glob.startsWith("/") || (glob.includes(",") && !glob.includes("{"))) {
      problems.push(`${id}: malformed glob ${JSON.stringify(glob)}`);
      continue;
    }
    const flows = glob.startsWith("flows:");
    if (flows !== (row.tree === "flows")) problems.push(`${id}: glob ${glob} does not match tree ${row.tree}`);
    if (!flows && glob.startsWith("docs/migration/")) continue; // this subtree is committed with the ledger; the driver excludes it from the plan body
    const files = listing(flows ? "flows" : "old");
    if (!files) continue;
    let expanded;
    try {
      expanded = braceExpand(flows ? glob.slice("flows:".length) : glob);
    } catch (error) {
      problems.push(`${id}: ${error.message}`);
      continue;
    }
    for (const one of expanded) {
      const re = globToRegExp(one.replace(/\/$/, ""));
      if (!files.some((file) => re.test(file))) problems.push(`${id}: glob ${glob} (${one}) matches no file in ${row.tree} at ${flows ? ledger.generatedFrom : ledger.trees.old.revision}`);
    }
  }
}

const ledgerSection = markdown.slice(markdown.indexOf("\n## Ledger"), markdown.indexOf("\n## Counts per disposition"));
const mdRows = ledgerSection.split("\n").filter((line) => line.startsWith("| ") && !line.startsWith("| Path") && !line.startsWith("| ---"));
if (mdRows.length !== ledger.entries.length) problems.push(`markdown has ${mdRows.length} table rows, JSON has ${ledger.entries.length}`);
for (const disposition of [...DISPOSITIONS, "decide"]) {
  const m = new RegExp(`^\\| ${disposition} \\| (\\d+) \\|$`, "m").exec(markdown);
  const want = counts.get(disposition) ?? 0;
  if (!m) problems.push(`markdown counts table has no ${disposition} row`);
  else if (Number(m[1]) !== want) problems.push(`markdown counts ${disposition}=${m[1]}, JSON has ${want}`);
}
if ((counts.get("decide") ?? 0) > 0) problems.push("decide rows remain");

if (problems.length) {
  for (const p of problems) console.error("problem:", p);
  process.exit(1);
}
const executable = ledger.entries.filter((row) => row.executable !== false).length;
console.log(`ok: ${ledger.entries.length} rows (${executable} executable, ${ledger.entries.length - executable} advisory), ${[...counts].map(([k, v]) => `${k} ${v}`).join(", ")}`);
