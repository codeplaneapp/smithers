#!/usr/bin/env node
/**
 * Every import a workspace source makes must be declared by that workspace.
 *
 * pnpm links the whole workspace under one `node_modules`, so a package can
 * import a sibling it never declared and still resolve locally. A consumer who
 * installs the published tarball gets a module-not-found error instead. This
 * gate is what PLAN.md Phase 3 means by "no package imports files through
 * unpublished workspace-relative paths".
 *
 * Test files, config files, and anything under a `scripts/` directory may use
 * `devDependencies`; everything else may use only runtime, peer, and optional
 * dependencies.
 *
 * Run it with `pnpm exec smithers-build test '//scripts:dependencyBoundaries'`, or
 * directly with `node scripts/check-dependency-boundaries.mjs`.
 */
import { builtinModules } from "node:module";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

// Resolved from this file, not from `process.cwd()`: the build system runs a
// target from the directory that owns it, and this gate is about the whole
// workspace.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// The `pnpm-workspace.yaml` membership globs: `packages/*` and `apps/*` are
// scanned by directory, `examples` and `packages/build/infra` are named.
const workspaceRoots = ["packages", "apps"];
const directWorkspaceDirs = ["examples", join("packages", "build", "infra")];
const sourceExtensions = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"]);
const ignoredDirs = new Set([
  ".alchemy",
  ".flows",
  ".git",
  ".jj",
  ".claude",
  ".smithers",
  ".turbo",
  ".worktrees",
  "worktrees",
  "coverage",
  "dist",
  "eval-runs",
  // The Smithers 0.x tree later phases port from. It is outside the workspace
  // and no live module imports it.
  "legacy",
  "node_modules",
  "target",
  "tmp",
]);
const builtinPackages = new Set(["bun", ...builtinModules, ...builtinModules.map((mod) => `node:${mod}`)]);

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

/** @param {string} dir @param {string[]} out @param {string[]} [nestedPackageDirs] */
export function collectSourceFiles(dir, out, nestedPackageDirs) {
  const absDir = join(repoRoot, dir);
  if (!isDirectory(absDir)) return;
  for (const entry of readdirSync(absDir)) {
    if (ignoredDirs.has(entry)) continue;
    const child = join(dir, entry);
    const absChild = join(repoRoot, child);
    // Skip symlinks before stat-following can recurse through workspace cycles
    // or crash on dangling local artifacts left by workflow runs.
    let stats;
    try {
      stats = lstatSync(absChild);
    } catch {
      continue;
    }
    if (stats.isSymbolicLink()) continue;
    if (stats.isDirectory()) {
      // A nested package.json with a name marks a standalone package (a
      // template, fixture, or shipped plugin). Its files are checked against
      // its own manifest, not the enclosing workspace's.
      if (nestedPackageDirs && readPackage(child)) {
        nestedPackageDirs.push(child);
        continue;
      }
      collectSourceFiles(child, out, nestedPackageDirs);
      continue;
    }
    if (!stats.isFile()) continue;
    // Build-graph declarations belong to the root workspace, not the package
    // they sit in: the build CLI loads them from the repository root against
    // the root install. `collectGraphFiles` gives them to the root package.
    if (entry === "legacy declaration" || entry === "PACKAGE.ts") continue;
    if (sourceExtensions.has(extname(entry))) out.push(child);
  }
}

/**
 * Collects every build-graph declaration in the tree, so the root workspace
 * checks them against the root manifest.
 *
 * The build CLI loads every `legacy declaration` from the repository root against the
 * root install, which is why `apps/server/legacy declaration` may import
 * `@smthrs/targets` without `apps/server` declaring it. Declarations inside a
 * scaffolding template describe the app the template generates, not this
 * repository, so a directory holding a manifest that is not a workspace member
 * is not descended into.
 *
 * @param {string} dir Repo-relative POSIX path, or "" for the repository root.
 * @param {Set<string>} memberDirs Repo-relative directories of workspace members.
 * @param {string[]} out
 */
export function collectGraphFiles(dir, memberDirs, out) {
  const absDir = join(repoRoot, dir === "" ? "." : dir);
  if (!isDirectory(absDir)) return;
  for (const entry of readdirSync(absDir)) {
    if (ignoredDirs.has(entry)) continue;
    const child = dir === "" ? entry : join(dir, entry);
    const absChild = join(repoRoot, child);
    let stats;
    try {
      stats = lstatSync(absChild);
    } catch {
      continue;
    }
    if (stats.isSymbolicLink()) continue;
    if (stats.isDirectory()) {
      const foreignProject = existsSync(join(absChild, "package.json")) &&
        !memberDirs.has(child) &&
        ![...memberDirs].some((member) => member.startsWith(`${child}${sep}`));
      if (foreignProject) continue;
      collectGraphFiles(child, memberDirs, out);
      continue;
    }
    if (entry === "legacy declaration" || entry === "PACKAGE.ts") out.push(child);
  }
}

/** @param {WorkspacePackage} pkg @param {Set<string>} [memberDirs] @returns {{ files: string[]; nestedPackageDirs: string[] }} */
function filesForPackage(pkg, memberDirs = new Set()) {
  /** @type {string[]} */
  const files = [];
  /** @type {string[]} */
  const nestedPackageDirs = [];
  if (pkg.dir === ".") {
    // The root workspace's own sources live under scripts/, and it owns every
    // build-graph declaration in the tree.
    collectSourceFiles("scripts", files, nestedPackageDirs);
    collectGraphFiles("", memberDirs, files);
  } else if (isDirectory(join(repoRoot, pkg.dir, "src"))) {
    collectSourceFiles(join(pkg.dir, "src"), files, nestedPackageDirs);
  } else {
    // Some workspaces have no src/ and keep their sources at the package root.
    // Scan the whole package dir; the recursive collector already skips
    // node_modules, dist, coverage, and legacy.
    collectSourceFiles(pkg.dir, files, nestedPackageDirs);
  }
  return { files: files.sort(), nestedPackageDirs: nestedPackageDirs.sort() };
}

/** @param {string} specifier */
function packageNameForSpecifier(specifier) {
  if (
    !specifier ||
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("#") ||
    specifier.startsWith("~/") ||
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
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindForPath(file));
  /** @type {Set<string>} */
  const specifiers = new Set();
  /** Character ranges of string/template literals, so the regex sweep below skips their contents. @type {[number, number][]} */
  const literalRanges = [];

  /** @param {ts.Node} node */
  function visit(node) {
    if (ts.isStringLiteralLike(node) || ts.isTemplateLiteral(node)) {
      literalRanges.push([node.getStart(sourceFile), node.getEnd()]);
    }
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

  // Belt-and-braces sweep for dynamic imports the AST walk can miss, run over a
  // copy with string and template literals blanked out. Without that, a dynamic
  // import quoted *inside* a string literal (a doc assertion needle, or the
  // workflow sources embedded in the generated pack) reads as a real import.
  const outsideLiterals = literalRanges.reduce(
    (acc, [start, end]) => acc.slice(0, start) + " ".repeat(end - start) + acc.slice(end),
    text,
  );
  for (const match of outsideLiterals.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    specifiers.add(match[1]);
  }
  return [...specifiers].sort();
}

/** @param {Record<string, unknown>} manifest @param {string} section */
function dependencyNames(manifest, section) {
  const deps = manifest[section];
  return deps && typeof deps === "object" && !Array.isArray(deps) ? new Set(Object.keys(deps)) : new Set();
}

/**
 * True for a file that only ever runs from a workspace install: tests, configs,
 * package scripts, and build-graph declarations. Such a file may use
 * `devDependencies`; a shipped source file may not.
 *
 * `legacy declaration` is a declaration the build CLI loads with the root install, and
 * no tarball contains one.
 *
 * @param {string} file
 */
function isDevOnlyFile(file) {
  const base = basename(file);
  const parts = file.split(sep);
  return (
    parts.includes("test") ||
    parts.includes("tests") ||
    parts.includes("__tests__") ||
    parts.includes("__type-tests__") ||
    parts.includes("scripts") ||
    base === "legacy declaration" ||
    base.includes(".test.") ||
    base.includes(".spec.") ||
    base.endsWith(".config.ts") ||
    base.endsWith(".config.js")
  );
}

/**
 * The dependency names a package's files may import.
 *
 * The runtime/dev split exists so a published tarball never imports something
 * a consumer's install does not fetch. A `private: true` workspace publishes no
 * tarball and always runs from the workspace install, so for one of those the
 * split carries no meaning and every declared section counts as runtime.
 *
 * @param {WorkspacePackage} pkg
 */
function dependencySets(pkg) {
  const declared = new Set([
    ...dependencyNames(pkg.manifest, "dependencies"),
    ...dependencyNames(pkg.manifest, "peerDependencies"),
    ...dependencyNames(pkg.manifest, "optionalDependencies"),
  ]);
  const dev = new Set([...declared, ...dependencyNames(pkg.manifest, "devDependencies")]);
  const runtime = pkg.manifest.private === true ? dev : declared;
  return { runtime, dev };
}

function main() {
  const workspacePackages = findWorkspacePackages();
  const workspaceNames = new Set(workspacePackages.map((pkg) => pkg.name));
  const memberDirs = new Set(workspacePackages.map((pkg) => pkg.dir).filter((dir) => dir !== "."));
  /** @type {Array<{ file: string; specifier: string; packageName: string; section: "dependencies" | "devDependencies" }>} */
  const violations = [];

  const packageQueue = [...workspacePackages];
  let checkedPackageCount = 0;
  while (packageQueue.length > 0) {
    const pkg = packageQueue.shift();
    checkedPackageCount += 1;
    const { files, nestedPackageDirs } = filesForPackage(pkg, memberDirs);
    for (const nestedDir of nestedPackageDirs) {
      const nestedPkg = readPackage(nestedDir);
      if (nestedPkg) packageQueue.push(nestedPkg);
    }
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
    console.log(`Dependency boundary check passed for ${checkedPackageCount} package(s).`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
