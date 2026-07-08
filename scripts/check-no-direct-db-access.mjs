#!/usr/bin/env node
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const defaultRoot = resolve(import.meta.dirname, "..");
const workspaceRoots = ["packages", "apps"];
const sourceExtensions = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"]);
const ignoredDirs = new Set(["dist", "node_modules"]);
const testDirs = new Set(["test", "tests", "__tests__"]);
const sanctionedSourceRoots = new Set([
  "packages/db/src",
  "packages/gateway/src",
  "packages/server/src",
]);

const directDbPattern =
  /new Database\(|new pg\.Client\(|new pg\.Pool\(|PGlite\.create\(/g;

const allowedDirectDbAccess = new Map([
  ["packages/engine/src/effect/builder.js", 3],
  ["packages/smithers/src/openSmithersStore.js", 4],
  ["packages/smithers/src/migrateSmithersStore.js", 6],
  ["packages/smithers/src/resolveSmithersBackendChoice.js", 3],
  ["packages/smithers/src/create.js", 3],
  ["packages/smithers/src/external/create-external-smithers.js", 1],
  ["apps/cli/src/index.js", 1],
  ["apps/cli/src/find-db.js", 1],
]);

/** @param {string} path */
function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** @param {string} path */
function toRelativePath(path) {
  return path.split("\\").join("/");
}

/** @param {string} file */
function isTestFile(file) {
  const base = basename(file);
  const parts = toRelativePath(file).split("/");
  return (
    parts.some((part) => testDirs.has(part)) ||
    base.includes(".test.") ||
    base.includes(".spec.")
  );
}

/** @param {string} rootDir */
function sourceRoots(rootDir) {
  /** @type {string[]} */
  const roots = [];
  for (const workspaceRoot of workspaceRoots) {
    const absWorkspaceRoot = join(rootDir, workspaceRoot);
    if (!isDirectory(absWorkspaceRoot)) continue;
    for (const entry of readdirSync(absWorkspaceRoot)) {
      if (ignoredDirs.has(entry) || testDirs.has(entry)) continue;
      const absSrc = join(absWorkspaceRoot, entry, "src");
      const relSrc = toRelativePath(relative(rootDir, absSrc));
      if (sanctionedSourceRoots.has(relSrc)) continue;
      if (isDirectory(absSrc)) roots.push(absSrc);
    }
  }
  return roots.sort();
}

/** @param {string} rootDir @param {string} dir @param {string[]} out */
function collectSourceFiles(rootDir, dir, out) {
  for (const entry of readdirSync(dir)) {
    if (ignoredDirs.has(entry) || testDirs.has(entry)) continue;
    const child = join(dir, entry);
    let stats;
    try {
      stats = lstatSync(child);
    } catch {
      continue;
    }
    if (stats.isSymbolicLink()) continue;
    if (stats.isDirectory()) {
      collectSourceFiles(rootDir, child, out);
      continue;
    }
    if (!stats.isFile()) continue;
    if (!sourceExtensions.has(extname(entry))) continue;

    const relFile = toRelativePath(relative(rootDir, child));
    if (!isTestFile(relFile)) out.push(child);
  }
}

/**
 * @param {string} [rootDir]
 * @returns {Map<string, number>}
 */
export function scanDirectDbAccess(rootDir = defaultRoot) {
  const resolvedRoot = resolve(rootDir);
  /** @type {string[]} */
  const files = [];
  for (const root of sourceRoots(resolvedRoot)) {
    if (existsSync(root)) collectSourceFiles(resolvedRoot, root, files);
  }

  const observed = new Map();
  for (const file of files.sort()) {
    const text = readFileSync(file, "utf8");
    const count = [...text.matchAll(directDbPattern)].length;
    if (count > 0) {
      observed.set(toRelativePath(relative(resolvedRoot, file)), count);
    }
  }
  return observed;
}

/** @param {Map<string, number>} observed */
function auditDirectDbAccess(observed) {
  let failed = false;

  for (const [file, count] of observed) {
    const allowed = allowedDirectDbAccess.get(file);
    if (allowed !== count) {
      console.error(
        `[db-access-audit] issue #470: unexpected direct DB constructor access in ${file}: expected ${allowed ?? 0}, found ${count}. Route it through the gateway, or if this is a deliberate interim addition, update the allowlist consciously.`,
      );
      failed = true;
    }
  }

  for (const [file, count] of allowedDirectDbAccess) {
    const actual = observed.get(file) ?? 0;
    if (actual !== count) {
      console.error(
        `[db-access-audit] issue #470: tracked direct DB constructor count changed in ${file}: expected ${count}, found ${actual}. If intentional, update the allowlist with the exact new count.`,
      );
      failed = true;
    }
  }

  if (!failed) {
    const total = [...observed.values()].reduce((sum, count) => sum + count, 0);
    console.log(
      `[db-access-audit] ${total} tracked direct DB constructor call(s); no untracked direct DB access`,
    );
  }

  return !failed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const clean = auditDirectDbAccess(scanDirectDbAccess());
  if (!clean) process.exit(1);
}
