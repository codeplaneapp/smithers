import { readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const CLI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TESTS_ROOT = join(CLI_ROOT, "tests");
const TEST_FILE = /\.(?:test|spec)(?:-[^.]+)?\.[cm]?[jt]sx?$/;
const EXCLUDED = new Set(["monitor-shell-controls.test.tsx"]);
const BATCH_SIZE = 1;

function collectTestFiles(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTestFiles(path, files);
    } else if (entry.isFile() && TEST_FILE.test(entry.name)) {
      const testPath = relative(TESTS_ROOT, path).split(sep).join("/");
      if (!EXCLUDED.has(testPath)) files.push(`./tests/${testPath}`);
    }
  }
  return files;
}

function runBatch(files) {
  return new Promise((resolveBatch) => {
    const child = spawn(process.execPath, ["test", "--isolate", "--timeout=120000", "--max-concurrency=1", ...files], {
      cwd: CLI_ROOT,
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", () => resolveBatch(1));
    child.once("exit", (code, signal) => resolveBatch(signal === null ? (code ?? 1) : 1));
  });
}

const files = collectTestFiles(TESTS_ROOT).sort();
const batchCount = Math.ceil(files.length / BATCH_SIZE);

for (let offset = 0; offset < files.length; offset += BATCH_SIZE) {
  const batch = files.slice(offset, offset + BATCH_SIZE);
  const batchNo = offset / BATCH_SIZE + 1;
  process.stdout.write(`[cli-tests] batch ${batchNo}/${batchCount}: ${batch.join(" ")}\n`);
  const exitCode = await runBatch(batch);
  if (exitCode !== 0) {
    process.exitCode = exitCode;
    break;
  }
}
