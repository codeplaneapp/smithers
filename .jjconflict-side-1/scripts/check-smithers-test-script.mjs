import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, "..");
const testFilePattern = /\.(?:test|spec)(?:-[^.]+)?\.[cm]?[jt]sx?$/;
const smithersPackageDir = join(root, ".smithers");

function containsRuntimeTestFile(dir) {
  if (!existsSync(dir)) {
    return false;
  }

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (containsRuntimeTestFile(path)) {
        return true;
      }
      continue;
    }

    if (entry.isFile() && testFilePattern.test(entry.name)) {
      return true;
    }
  }

  return false;
}

function collectRuntimeTestFiles(dir, out) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      collectRuntimeTestFiles(path, out);
    } else if (entry.isFile() && testFilePattern.test(entry.name)) {
      out.push(path);
    }
  }
}

// A `bun test` script covers a file when it lists the file itself or an ancestor
// directory as a path argument (optionally prefixed with `./` and/or suffixed
// with `/`). This works for both explicit file lists and directory globs.
function scriptRunsFile(script, rel) {
  const parts = rel.split("/");
  const candidates = [rel];
  for (let i = parts.length - 1; i > 0; i -= 1) {
    candidates.push(parts.slice(0, i).join("/"));
  }
  return candidates.some((candidate) => {
    const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|\\s)\\.?/?${escaped}/?(\\s|$)`).test(script);
  });
}

function workspacePackageDirs() {
  const dirs = [];
  for (const parent of ["packages", "apps"]) {
    const parentDir = join(root, parent);
    if (!existsSync(parentDir)) continue;

    for (const entry of readdirSync(parentDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const packageDir = join(parentDir, entry.name);
      if (existsSync(join(packageDir, "package.json"))) dirs.push(packageDir);
    }
  }
  if (existsSync(smithersPackageDir) && existsSync(join(smithersPackageDir, "package.json"))) {
    dirs.push(smithersPackageDir);
  }
  return dirs;
}

let failed = false;

for (const packageDir of workspacePackageDirs()) {
  const manifestPath = join(packageDir, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const hasTests = [
    join(packageDir, "tests"),
    join(packageDir, "src"),
    join(packageDir, "server"),
  ].some(containsRuntimeTestFile);

  if (hasTests && typeof manifest.scripts?.test !== "string") {
    console.error(
      `${relative(root, manifestPath)} has runtime tests but no scripts.test for pnpm -r test`,
    );
    failed = true;
    continue;
  }

  if (packageDir === smithersPackageDir) {
    // Enforce per-file coverage: every runtime test file under .smithers/{tests,
    // ui,lib} must be run by at least one `bun test` script (test, test:ddd,
    // test:ddd:browser, or test:open-code-review), so new .smithers suites can
    // never silently go dark in CI the way the DDD suites once did.
    const scripts = manifest.scripts ?? {};
    const bunTestScripts = Object.entries(scripts)
      .filter(([, value]) => typeof value === "string" && /\bbun\s+test\b/.test(value))
      .map(([name, value]) => ({ name, value }));
    const testFiles = [];
    for (const sub of ["tests", "ui", "lib"]) {
      collectRuntimeTestFiles(join(packageDir, sub), testFiles);
    }
    for (const file of testFiles) {
      const rel = relative(packageDir, file).split(sep).join("/");
      if (!bunTestScripts.some((script) => scriptRunsFile(script.value, rel))) {
        console.error(
          `.smithers/${rel} is a runtime test file but no "bun test" script runs it; add it to one of: ${
            bunTestScripts.map((script) => script.name).join(", ") || "scripts.test"
          }.`,
        );
        failed = true;
      }
    }
  }
}

if (failed) process.exitCode = 1;
