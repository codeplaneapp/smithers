import { readFileSync } from "node:fs";
import { join } from "node:path";

import { config } from "./config.js";

/**
 * Remove binary diff sections from a git patch. Faithful port of
 * `swe_bench_pro_eval.py::strip_binary_hunks` — binary hunks cannot be applied
 * with `git apply` from a plain unified diff and would abort the whole patch.
 *
 * @param {string} patch
 * @returns {string}
 */
export function stripBinaryHunks(patch) {
  if (!patch) return patch;
  const sections = patch.split(/(?=^diff --git )/m);
  const kept = [];
  for (const section of sections) {
    if (!section.trim()) continue;
    if (/^Binary files .* differ$/m.test(section)) continue;
    if (/^GIT binary patch$/m.test(section)) continue;
    kept.push(section);
  }
  return kept.join("");
}

/**
 * Read `ENV` lines from a dockerfile and rewrite them as shell `export`s, so the
 * scoring shell reproduces the image's build-time environment (e.g. PYTEST_ADDOPTS).
 *
 * @param {string} path
 * @returns {string[]}
 */
function envExportsFromDockerfile(path) {
  let content;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (t.startsWith("ENV")) out.push(t.replace("ENV", "export"));
  }
  return out;
}

/**
 * Build the in-container evaluation script for one instance. This is a faithful
 * port of `swe_bench_pro_eval.py::create_entryscript`: it reproduces the exact
 * command sequence ScaleAI runs to score a patch, so a smithers run and the
 * canonical harness reach identical verdicts.
 *
 * Order matters and is deliberately preserved:
 *   1. export the image's ENV vars
 *   2. reset /app to base_commit
 *   3. apply the candidate patch (the agent's diff, or gold, or empty)
 *   4. run the *last line* of before_repo_set_cmd — which checks the hidden
 *      test files out of the fix commit (this is why the agent never sees them)
 *   5. run the canonical run_script.sh over the selected tests
 *   6. parse stdout/stderr into output.json with the canonical parser.py
 *
 * @param {import("./loadInstances.js").SwebpInstance} instance
 * @returns {string}
 */
export function createEntryScript(instance) {
  const row = instance.raw;
  const beforeRepoSetCmd = String(row.before_repo_set_cmd ?? "")
    .trim()
    .split("\n")
    .pop();
  const selected = instance.selectedTestFiles.join(",");
  const baseCommit = instance.baseCommit;
  const iid = instance.instanceId;

  const envCmds = [
    ...envExportsFromDockerfile(join(config.harnessDir, "dockerfiles", "base_dockerfile", iid, "Dockerfile")),
    ...envExportsFromDockerfile(join(config.harnessDir, "dockerfiles", "instance_dockerfile", iid, "Dockerfile")),
  ].join("\n");

  return `${envCmds}
# apply patch
cd /app
git reset --hard ${baseCommit}
git checkout ${baseCommit}
git apply -v /workspace/patch.diff
${beforeRepoSetCmd}
# run test and save stdout and stderr to separate files
bash /workspace/run_script.sh ${selected} > /workspace/stdout.log 2> /workspace/stderr.log
# run parsing script
python /workspace/parser.py /workspace/stdout.log /workspace/stderr.log /workspace/output.json
`;
}
