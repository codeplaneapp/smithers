#!/usr/bin/env bun
/**
 * generate-workflow-pack.ts
 *
 * Single source of truth for the workflows that `smithers init` seeds.
 *
 * This generator reads the canonical seeded files straight from
 * `.smithers/workflows/` (and the prompts they import from `.smithers/prompts/`)
 * and emits a generated module that `workflow-pack.js` splices into the init
 * pack verbatim — no escaping, no drift.
 *
 * Adding a workflow to `smithers init` is now:
 *   1. Author it in `.smithers/workflows/<id>.tsx` with the seeded header
 *      (`// smithers-source: seeded`, `// smithers-display-name: …`, …).
 *   2. Add its id to SEEDED_WORKFLOW_IDS below only when intentionally changing
 *      the curated public/system inventory.
 *   3. `bun scripts/generate-workflow-pack.ts` and commit the regenerated module.
 *
 * `create-workflow`'s own scaffold step can run this for you so authoring a
 * workflow ships it to init automatically.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkUiArchitecture } from "./check-ui-architecture.mjs";
import { generateInitTemplates } from "./generate-init-templates.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SMITHERS_DIR = resolve(REPO_ROOT, ".smithers");
const OUTPUT_FILE = resolve(REPO_ROOT, "apps/cli/src/seeded-workflow-pack.generated.js");

/**
 * Workflows whose canonical `.smithers/workflows/<id>.tsx` ships in `smithers
 * init`. The entries are the curated contract, not an à-la-carte catalog.
 */
const SEEDED_WORKFLOW_IDS = [
  "create-workflow",
  "create-skill",
  // Auto-launched by the monitor's "Create UI" action (system workflow).
  "create-ui",
  "docs-driven-development",
  // Durable `smithers init` (system workflow — hidden from default listings).
  "init",
  // Auto-launched autopsy for failed runs (system workflow).
  "post-failure",
  // Agent-assisted CLI/plugin upgrade wrapper (system workflow).
  "upgrade",
  // Parent workflow the `evals` gateway extension launches to run a saved
  // suite's cases as real child runs (system workflow — issue #77).
  "eval-suite-run",
  // Durable pack installation (system workflow — hidden from default listings).
  "add",
  // Guided pack publishing workflow.
  "share-pack",
  "smithers-repo-federation",
  "whole-foods-meal-planner",
];

type TemplateFile = { path: string; contents: string };

/**
 * Seeded ids whose canonical multi-file UI (`.smithers/ui/<id>.tsx` plus its
 * relative sibling modules) ships with the pack.
 */
const SEEDED_UI_IDS = new Set([
  "create-workflow",
  "create-skill",
  "docs-driven-development",
  "share-pack",
  "smithers-repo-federation",
  "whole-foods-meal-planner",
]);

const DDD_HELPER_FILES = [
  "auditInputs.ts",
  "build.ts",
  "dddRoot.ts",
  "featuresSchema.ts",
  "generateSpecDocs.ts",
  "generateUiModules.ts",
  "triageCandidates.ts",
  "validateFeatures.ts",
];

/** Prompts a workflow imports from `../prompts/<name>.mdx`. */
function promptImportsOf(source: string): string[] {
  const names = new Set<string>();
  const re = /from\s+["']\.\.\/prompts\/([^"']+\.mdx)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) names.add(m[1]);
  return [...names];
}

/**
 * Local `.smithers/lib/*` modules a workflow imports (`../lib/<spec>`). These
 * are plain TS helpers (extracted so they can be unit-tested without an agent).
 * They have no other install path, so init only ships them when the curated
 * inventory embeds them. Returns the import specifiers verbatim (may omit the
 * extension).
 */
function libImportsOf(source: string): string[] {
  const specs = new Set<string>();
  const re = /from\s+["']\.\.\/lib\/([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) specs.add(m[1]);
  return [...specs];
}

/**
 * Relative imports inside a lib module (`./x`, `../y`), resolved against the
 * module's own path (relative to `.smithers/lib/`). Anything that escapes
 * `.smithers/lib/` is rejected — seeded lib helpers must stay self-contained.
 */
function libRelativeImportsOf(source: string, fromLibPath: string): string[] {
  const names = new Set<string>();
  const re = /from\s+["'](\.\.?\/[^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    // Import specifiers are POSIX regardless of host OS; normalize in POSIX
    // space so the escape check cannot be confused by win32 drive letters.
    const joined = posix.normalize(posix.join(posix.dirname(fromLibPath), m[1]));
    if (joined.startsWith("..")) {
      throw new Error(
        `Seeded lib module .smithers/lib/${fromLibPath} imports ${m[1]}, which escapes .smithers/lib/. ` +
          "Seeded lib helpers must be self-contained under .smithers/lib/.",
      );
    }
    names.add(joined);
  }
  return [...names];
}

/**
 * Relative imports inside a `.smithers/ui/*` module (`./x`), resolved against
 * the module's own path (relative to `.smithers/ui/`). Anything that escapes
 * `.smithers/ui/` is rejected — seeded UI modules must stay self-contained.
 * Test modules are never part of the shipped closure.
 */
function uiRelativeImportsOf(source: string, fromUiPath: string): string[] {
  const names = new Set<string>();
  // Static `from "./x"` AND dynamic `import("./x")` forms — seeded UIs lazy-load
  // heavy editors via dynamic import, and missing those breaks a fresh init.
  const re = /(?:from\s+|import\s*\(\s*)["'](\.\.?\/[^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const joined = posix.normalize(posix.join(posix.dirname(fromUiPath), m[1]));
    if (joined.startsWith("..")) {
      throw new Error(
        `Seeded ui module .smithers/ui/${fromUiPath} imports ${m[1]}, which escapes .smithers/ui/. ` +
          "Seeded UIs must be self-contained under .smithers/ui/.",
      );
    }
    if (/\.test\.(t|j)sx?$/.test(joined) || joined.includes(".test.")) continue;
    names.add(joined);
  }
  return [...names];
}

/** Resolve a ui import specifier to an on-disk file under `.smithers/ui/`. */
function resolveUiFile(specifier: string): { relPath: string; absPath: string } {
  const candidates = /\.(tsx?|ts|js|json)$/.test(specifier) ? [specifier] : [`${specifier}.tsx`, `${specifier}.ts`];
  for (const candidate of candidates) {
    const absPath = resolve(SMITHERS_DIR, "ui", candidate);
    if (existsSync(absPath)) return { relPath: candidate, absPath };
  }
  throw new Error(
    `Seeded ui import "${specifier}" does not resolve to a file under .smithers/ui/ (tried: ${candidates.join(", ")}).`,
  );
}

/** Resolve a lib import specifier to an on-disk file under `.smithers/lib/`. */
function resolveLibFile(specifier: string): { relPath: string; absPath: string } {
  const candidates =
    specifier.endsWith(".ts") || specifier.endsWith(".tsx")
      ? [specifier]
      : [specifier, `${specifier}.ts`, `${specifier}.tsx`, `${specifier}/index.ts`, `${specifier}/index.tsx`];
  for (const candidate of candidates) {
    const absPath = resolve(SMITHERS_DIR, "lib", candidate);
    if (existsSync(absPath)) return { relPath: candidate, absPath };
  }
  throw new Error(
    `Cannot resolve seeded lib import "../lib/${specifier}" under ${resolve(SMITHERS_DIR, "lib")} ` +
      `(tried: ${candidates.join(", ")})`,
  );
}

function readOrThrow(absPath: string, label: string): string {
  if (!existsSync(absPath)) {
    throw new Error(`Missing ${label}: ${absPath}`);
  }
  return readFileSync(absPath, "utf8");
}

function dddStarterUiContents(relPath: string, canonical: string): string {
  if (relPath === "ddd-features.generated.ts") return "export const featuresData = [];\n";
  if (relPath === "ddd-docsContent.generated.ts")
    return 'export const docsContent: { path: string; title: string; level: "product" | "technical"; content: string }[] = [];\nexport type DocsContentEntry = (typeof docsContent)[number];\n';
  if (relPath === "ddd-ticketsBacklog.generated.ts") return "export const ticketsBacklog = [];\n";
  if (relPath === "ddd-workflowSource.generated.ts")
    return 'export const workflowSourcePath = ".smithers/workflows/docs-driven-development.tsx";\nexport const workflowSource = "";\nexport const workflowSources = {};\n';
  return canonical;
}

function build(): TemplateFile[] {
  const files: TemplateFile[] = [];
  const byPath = new Map<string, TemplateFile>();

  const seededIds = new Set(SEEDED_WORKFLOW_IDS);
  for (const entry of readdirSync(resolve(SMITHERS_DIR, "workflows"), { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".tsx")) continue;
    const source = readFileSync(resolve(SMITHERS_DIR, "workflows", entry.name), "utf8");
    if (/^\/\/\s*smithers-source:\s*seeded\b/m.test(source)) {
      const id = entry.name.slice(0, -".tsx".length);
      if (!seededIds.has(id)) {
        throw new Error(
          `${entry.name} carries the "// smithers-source: seeded" header but is missing from SEEDED_WORKFLOW_IDS. ` +
            "Add it to the curated seed inventory or relabel the workflow source.",
        );
      }
    }
  }

  const push = (path: string, contents: string) => {
    const existing = byPath.get(path);
    if (existing) return;
    const file: TemplateFile = { path, contents };
    byPath.set(path, file);
    files.push(file);
  };

  for (const id of SEEDED_WORKFLOW_IDS) {
    const workflowAbs = resolve(SMITHERS_DIR, "workflows", `${id}.tsx`);
    const workflowSource = readOrThrow(workflowAbs, `seeded workflow ${id}`);

    if (!/^\/\/\s*smithers-source:\s*seeded\b/m.test(workflowSource)) {
      throw new Error(
        `${id}.tsx is in SEEDED_WORKFLOW_IDS but is missing the "// smithers-source: seeded" header. ` +
          "Seeded workflows must carry the full seeded header so init ships them verbatim.",
      );
    }

    push(`.smithers/workflows/${id}.tsx`, workflowSource);

    for (const promptName of promptImportsOf(workflowSource)) {
      const promptAbs = resolve(SMITHERS_DIR, "prompts", promptName);
      const promptSource = readOrThrow(promptAbs, `prompt ${promptName} for workflow ${id}`);
      push(`.smithers/prompts/${promptName}`, promptSource);
    }

    // Bundle `../lib/*` helpers (transitively) so a seeded workflow loads from
    // a fresh init — a workflow shipped without its lib imports fails
    // `smithers graph` with a module-not-found the moment it is seeded.
    const libQueue = libImportsOf(workflowSource).map((specifier) => resolveLibFile(specifier));
    if (id === "docs-driven-development") {
      for (const helper of DDD_HELPER_FILES) libQueue.push(resolveLibFile(`ddd/${helper}`));
      push(".smithers/spec/features.json", "[]\n");
      push(
        ".smithers/spec/content/overview.md",
        "# Product specification\n\nThis starter spec is intentionally empty. Run docs-driven-development to describe the target repository.\n",
      );
    }
    const visitedLibs = new Set<string>();
    while (libQueue.length > 0) {
      const { relPath, absPath } = libQueue.shift()!;
      if (visitedLibs.has(relPath)) continue;
      visitedLibs.add(relPath);
      const libSource = readOrThrow(absPath, `lib module ${relPath} for workflow ${id}`);
      push(`.smithers/lib/${relPath}`, libSource);
      for (const nested of libRelativeImportsOf(libSource, relPath)) {
        libQueue.push(resolveLibFile(nested));
      }
    }

    // Bundle the canonical multi-file UI (entry + its relative imports,
    // transitively; tests excluded) for ids in SEEDED_UI_IDS, so init writes
    // the real UI instead of the generic template.
    if (SEEDED_UI_IDS.has(id)) {
      const uiQueue = [resolveUiFile(`${id}.tsx`)];
      const visitedUi = new Set<string>();
      while (uiQueue.length > 0) {
        const { relPath, absPath } = uiQueue.shift()!;
        if (visitedUi.has(relPath)) continue;
        visitedUi.add(relPath);
        const uiSource = dddStarterUiContents(relPath, readOrThrow(absPath, `ui module ${relPath} for workflow ${id}`));
        push(`.smithers/ui/${relPath}`, uiSource);
        for (const nested of uiRelativeImportsOf(uiSource, relPath)) {
          uiQueue.push(resolveUiFile(nested));
        }
      }
    }
  }

  return files;
}

function emit(files: TemplateFile[]): string {
  const banner = [
    "// AUTO-GENERATED by scripts/generate-workflow-pack.ts — DO NOT EDIT BY HAND.",
    "// Edit the canonical sources in .smithers/workflows + .smithers/prompts and re-run the generator.",
    "//",
    "// Seeded workflow ids: " + SEEDED_WORKFLOW_IDS.join(", "),
    "",
    "/** @typedef {{ path: string; contents: string }} TemplateFile */",
    "",
    "/** @type {TemplateFile[]} */",
    "export const GENERATED_SEEDED_FILES = ",
  ].join("\n");
  return `${banner}${JSON.stringify(files, null, 2)};\n`;
}

function main() {
  const architecture = checkUiArchitecture({
    root: REPO_ROOT,
    baselinePath: "scripts/ui-architecture-baseline.json",
  });
  if (!architecture.ok) {
    throw new Error(
      "Workflow-pack UI architecture check failed. Resolve the violation or ratchet only an existing legacy violation in scripts/ui-architecture-baseline.json:\n" +
        architecture.errors.map((error) => `- ${error}`).join("\n"),
    );
  }
  const files = build();
  const output = emit(files);
  writeFileSync(OUTPUT_FILE, output, "utf8");
  const workflows = files.filter((f) => f.path.includes("/workflows/")).length;
  const prompts = files.filter((f) => f.path.includes("/prompts/")).length;
  const libs = files.filter((f) => f.path.startsWith(".smithers/lib/")).length;
  process.stdout.write(
    `[generate-workflow-pack] wrote ${files.length} file(s) (${workflows} workflow, ${prompts} prompt, ${libs} lib) ` +
      `to ${OUTPUT_FILE.replace(REPO_ROOT + "/", "")}\n`,
  );
  for (const f of files) process.stdout.write(`  + ${f.path}\n`);
  const initTemplates = generateInitTemplates();
  process.stdout.write(
    `[generate-init-templates] wrote ${initTemplates.files.length} template(s) ` +
      `to ${initTemplates.outputFile.replace(REPO_ROOT + "/", "")}\n`,
  );
}

main();
