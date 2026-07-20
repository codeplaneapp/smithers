// Apply triage docFix patches: insert each markdown block after its (unique)
// anchorLine in the target docs/*.mdx file. Reports what applied / skipped.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

type Result = {
  id: string;
  classification: string;
  docFix?: { file: string; anchorLine: string; markdown: string };
  libraryIssue?: { title: string; body: string };
};

const file = process.argv[2] ?? "evals/_inventory/triage-results.json";
const results: Result[] = JSON.parse(readFileSync(file, "utf8"));

for (const r of results) {
  const fix = r.docFix;
  if (!fix) {
    console.log(`- ${r.id}: no docFix`);
    continue;
  }
  if (!existsSync(fix.file)) {
    console.log(`✗ ${r.id}: file not found ${fix.file}`);
    continue;
  }
  const src = readFileSync(fix.file, "utf8");
  const lines = src.split("\n");
  const idx = lines.findIndex((l) => l.trim() === fix.anchorLine.trim());
  const count = lines.filter((l) => l.trim() === fix.anchorLine.trim()).length;
  if (idx < 0) {
    console.log(`✗ ${r.id}: anchor NOT found in ${fix.file}: ${JSON.stringify(fix.anchorLine.slice(0, 70))}`);
    continue;
  }
  if (count > 1) {
    console.log(`✗ ${r.id}: anchor NOT unique (${count}x) in ${fix.file}`);
    continue;
  }
  if (src.includes(fix.markdown.trim().slice(0, 40))) {
    console.log(`= ${r.id}: already applied in ${fix.file}`);
    continue;
  }
  lines.splice(idx + 1, 0, fix.markdown);
  writeFileSync(fix.file, lines.join("\n"));
  console.log(`✓ ${r.id}: inserted into ${fix.file} after line ${idx + 1}`);
}
