#!/usr/bin/env node
import { builtinModules } from "node:module";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { basename, extname, join, relative, sep } from "node:path";
import ts from "typescript";

const repoRoot = process.cwd();
const workspaceRoots = ["packages", "apps"];
const directWorkspaceDirs = ["e2e"];
const sourceExtensions = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"]);
const ignoredDirs = new Set([
  ".git",
  ".jj",
  ".claude",
  ".smithers",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
]);
const builtinPackages = new Set([
  "bun",
  ...builtinModules,
  ...builtinModules.map((mod) => `node:${mod}`),
]);

/** @typedef {{ dir: string; name: string; manifestPath: string; manifest: Record<string, unknown> }} WorkspacePackage */

/** @param {string} path */
function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** @param {string} path */
function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** @param {string} dir */
function readPackage(dir) {
  const manifestPath = join(repoRoot, dir, "package.json");
  if (!existsSync(manifestPath)) return null;
  const manifest = readJson(manifestPath);
  if (!manifest?.name || typeof manifest.name !== "string") return null;
  return { dir, name: manifest.name, manifestPath, manifest };
}

/** @returns {WorkspacePackage[]} */
function findWorkspacePackages() {
  /** @type {WorkspacePackage[]} */
  const packages = [];
  for (const root of workspaceRoots) {
    const absRoot = join(repoRoot, root);
    if (!isDirectory(absRoot)) continue;
    for (const entry of readdirSync(absRoot)) {
      const dir = join(root, entry);
      const pkg = readPackage(dir);
      if (pkg) packages.push(pkg);
    }
  }
  for (const dir of directWorkspaceDirs) {
    const pkg = readPackage(dir);
    if (pkg) packages.push(pkg);
  }
  const rootPackage = readPackage(".");
  if (rootPackage) packages.push(rootPackage);
  return packages.sort((a, b) => a.dir.localeCompare(b.dir));
}

/** @param {string} dir @param {string[]} out */
function collectSourceFiles(dir, out) {
  const absDir = join(repoRoot, dir);
  if (!isDirectory(absDir)) return;
  for (const entry of readdirSync(absDir)) {
    if (ignoredDirs.has(entry)) continue;
    const child = join(dir, entry);
    const absChild = join(repoRoot, child);
    const stats = statSync(absChild);
    if (stats.isDirectory()) {
      collectSourceFiles(child, out);
      continue;
    }
    if (!stats.isFile()) continue;
    if (sourceExtensions.has(extname(entry))) out.push(child);
  }
}

/** @param {WorkspacePackage} pkg */
function filesForPackage(pkg) {
  /** @type {string[]} */
  const files = [];
  const roots = pkg.dir === "." ? ["scripts"] : ["src"];
  for (const root of roots) collectSourceFiles(join(pkg.dir, root), files);
  return files.sort();
}

/** @param {string} specifier */
function packageNameForSpecifier(specifier) {
  if (
    !specifier ||
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("#") ||
    specifier.startsWith("node:") ||
    specifier.startsWith("bun:")
  ) {
    return null;
  }
  if (builtinPackages.has(specifier)) return null;
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) {
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
  }
  return parts[0] ?? null;
}

/** @param {string} path */
function scriptKindForPath(path) {
  if (path.endsWith(".tsx") || path.endsWith(".jsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".ts")) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

/** @param {string} file */
function importSpecifiersForFile(file) {
  const absFile = join(repoRoot, file);
  const text = readFileSync(absFile, "utf8");
  const sourceFile = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForPath(file),
  );
  /** @type {Set<string>} */
  const specifiers = new Set();

  /** @param {ts.Node} node */
  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.add(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      specifiers.add(node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node)) {
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length === 1 &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        specifiers.add(node.arguments[0].text);
      } else if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require" &&
        node.arguments.length === 1 &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        specifiers.add(node.arguments[0].text);
      }
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      specifiers.add(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  for (const match of text.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    specifiers.add(match[1]);
  }
  return [...specifiers].sort();
}

/** @param {Record<string, unknown>} manifest @param {string} section */
function dependencyNames(manifest, section) {
  const deps = manifest[section];
  return deps && typeof deps === "object" && !Array.isArray(deps)
    ? new Set(Object.keys(deps))
    : new Set();
}

/** @param {string} file */
function isDevOnlyFile(file) {
  const base = basename(file);
  const parts = file.split(sep);
  return (
    parts.includes("tests") ||
    parts.includes("__tests__") ||
    parts.includes("__type-tests__") ||
    parts.includes("scripts") ||
    base.includes(".test.") ||
    base.includes(".spec.") ||
    base.endsWith(".config.ts") ||
    base.endsWith(".config.js")
  );
}

/** @param {WorkspacePackage} pkg */
function dependencySets(pkg) {
  const runtime = new Set([
    ...dependencyNames(pkg.manifest, "dependencies"),
    ...dependencyNames(pkg.manifest, "peerDependencies"),
    ...dependencyNames(pkg.manifest, "optionalDependencies"),
  ]);
  const dev = new Set([
    ...runtime,
    ...dependencyNames(pkg.manifest, "devDependencies"),
  ]);
  return { runtime, dev };
}

const workspacePackages = findWorkspacePackages();
const workspaceNames = new Set(workspacePackages.map((pkg) => pkg.name));
/** @type {Array<{ file: string; specifier: string; packageName: string; section: "dependencies" | "devDependencies" }>} */
const violations = [];

for (const pkg of workspacePackages) {
  const files = filesForPackage(pkg);
  const deps = dependencySets(pkg);
  for (const file of files) {
    const devOnly = isDevOnlyFile(file);
    const allowed = devOnly ? deps.dev : deps.runtime;
    const expectedSection = devOnly ? "devDependencies" : "dependencies";
    for (const specifier of importSpecifiersForFile(file)) {
      const packageName = packageNameForSpecifier(specifier);
      if (!packageName || packageName === pkg.name) continue;
      if (allowed.has(packageName)) continue;
      violations.push({ file, specifier, packageName, section: expectedSection });
    }
  }
}

if (violations.length > 0) {
  console.error("Dependency boundary check failed: undeclared imports found.\n");
  for (const violation of violations) {
    const workspaceHint = workspaceNames.has(violation.packageName) ? "workspace dependency" : "dependency";
    console.error(
      `- ${relative(repoRoot, join(repoRoot, violation.file))} imports ${violation.specifier}; ` +
        `declare ${violation.packageName} as a ${workspaceHint} in ${violation.section}.`,
    );
  }
  process.exitCode = 1;
} else {
  console.log(`Dependency boundary check passed for ${workspacePackages.length} workspace package(s).`);
}
