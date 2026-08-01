import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const samplePath = join(root, "benchmarks", "orchbench", "persuasion-gap-sample.json");
const sample = JSON.parse(readFileSync(samplePath, "utf8")) as {
  study: string;
  datasetRevision: string;
  pilotExcluded: string[];
  candidates: Record<string, string[]>;
};
const treePath = resolve(
  process.argv[2] ??
    join(root, ".context", "roadmapbench", "data", ".cache", "huggingface", "trees", `${sample.datasetRevision}.json`),
);
const tree = JSON.parse(readFileSync(treePath, "utf8")) as { files: Record<string, unknown> };
const tasks = [
  ...new Set(
    Object.keys(tree.files)
      .filter((path) => path.includes("/"))
      .map((path) => path.split("/")[0])
      .filter(Boolean),
  ),
];
if (basename(treePath, ".json") !== sample.datasetRevision) throw new Error("dataset revision does not match sample");
if (tasks.length !== 115) throw new Error(`expected 115 RoadmapBench tasks, found ${tasks.length}`);

const prefixes: Record<string, string[]> = {
  "C++": ["glz", "tpl"],
  Go: ["fbr", "fyn", "ktx"],
  Python: ["fal", "opt", "plr", "pyg", "spc"],
  Rust: ["dsl", "rat", "ruf", "slt"],
  TypeScript: ["mko", "prm", "vbt"],
};
const hash = (task: string) => createHash("sha256").update(`${sample.study}:${task}`).digest("hex");
for (const [language, languagePrefixes] of Object.entries(prefixes)) {
  const expected = tasks
    .filter((task) => languagePrefixes.includes(task.split("-")[0]!) && !sample.pilotExcluded.includes(task))
    .sort((a, b) => hash(a).localeCompare(hash(b)))
    .slice(0, sample.candidates[language]!.length);
  if (JSON.stringify(expected) !== JSON.stringify(sample.candidates[language])) {
    throw new Error(`${language} candidate order does not match the frozen hash rule`);
  }
  console.log(`${language}: ${expected.length} candidates verified`);
}
