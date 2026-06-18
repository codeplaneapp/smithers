import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const packageDir = join(root, "packages", "smithers");
const manifestPath = join(packageDir, "package.json");
const testFilePattern = /\.(?:test|spec)(?:-[^.]+)?\.[cm]?[jt]sx?$/;

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

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

if (
  containsRuntimeTestFile(join(packageDir, "tests")) &&
  typeof manifest.scripts?.test !== "string"
) {
  console.error(
    `${relative(root, manifestPath)} has runtime tests but no scripts.test for pnpm -r test`,
  );
  process.exitCode = 1;
}
