#!/usr/bin/env bun
/**
 * generate-workflow-pack.ts
 *
 * Single source of truth for the workflows that `smithers init` seeds.
 *
 * The legacy seeded pack is hand-embedded as escaped string arrays inside
 * `apps/cli/src/workflow-pack.js`. That duplicates the canonical dogfood files
 * in `.smithers/` and forces a manual, error-prone port every time a workflow
 * is added. This generator reads the canonical seeded files straight from
 * `.smithers/workflows/` (and the prompts they import from `.smithers/prompts/`)
 * and emits a generated module that `workflow-pack.js` splices into the init
 * pack verbatim — no escaping, no drift.
 *
 * Adding a workflow to `smithers init` is now:
 *   1. Author it in `.smithers/workflows/<id>.tsx` with the seeded header
 *      (`// smithers-source: seeded`, `// smithers-display-name: …`, …).
 *   2. Add its id to SEEDED_WORKFLOW_IDS below.
 *   3. `bun scripts/generate-workflow-pack.ts` and commit the regenerated module.
 *
 * `create-workflow`'s own scaffold step can run this for you so authoring a
 * workflow ships it to init automatically.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SMITHERS_DIR = resolve(REPO_ROOT, ".smithers");
const OUTPUT_FILE = resolve(REPO_ROOT, "apps/cli/src/seeded-workflow-pack.generated.js");

/**
 * Workflows whose canonical `.smithers/workflows/<id>.tsx` ships in `smithers
 * init`. Extend this list (and re-run the generator) to add a workflow to the
 * init pack. The legacy inline workflows in workflow-pack.js are NOT listed
 * here yet — they can be migrated incrementally.
 */
const SEEDED_WORKFLOW_IDS = [
  // The smallest possible workflow — the first thing a new user runs/edits.
  "hello",
  "create-workflow",
  // Concierge suite (generated from canonical .smithers sources).
  "context-engineer",
  "route-task",
  "create-skill",
  "extract-skill",
  "monitor-smithers",
  "monitor",
  "triage-run",
  "context-doctor",
  "backpressure-plan",
  "eval-author",
  "report-slideshow",
  // Fable-as-operator meta-workflow (authored in fable-smithers, moved here).
  "smithering",
  // First-run tutorial that recommends and builds a project-specific workflow.
  "make-workflow-tutorial",
  // Durable `smithers init` (system workflow — hidden from default listings).
  "init",
  // Auto-launched autopsy for failed runs (system workflow).
  "post-failure",
];

type TemplateFile = { path: string; contents: string; owners?: string[] };

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
 * are plain TS helpers (extracted so they can be unit-tested without an agent);
 * unlike components — which init materializes from the WORKFLOW_MANIFEST — lib
 * files have no other install path, so init only ships them if the pack embeds
 * them. Returns the import specifiers verbatim (may omit the extension).
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

function build(): TemplateFile[] {
  const files: TemplateFile[] = [];
  const byPath = new Map<string, TemplateFile>();

  // Dedup shared files across workflows; `owner` records which seeded
  // workflow(s) pull the file in so init can install lib helpers only with
  // the workflows that import them.
  const push = (path: string, contents: string, owner?: string) => {
    const existing = byPath.get(path);
    if (existing) {
      if (owner) {
        existing.owners ??= [];
        if (!existing.owners.includes(owner)) existing.owners.push(owner);
      }
      return;
    }
    const file: TemplateFile = { path, contents };
    if (owner) file.owners = [owner];
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
    const visitedLibs = new Set<string>();
    while (libQueue.length > 0) {
      const { relPath, absPath } = libQueue.shift()!;
      if (visitedLibs.has(relPath)) continue;
      visitedLibs.add(relPath);
      const libSource = readOrThrow(absPath, `lib module ${relPath} for workflow ${id}`);
      push(`.smithers/lib/${relPath}`, libSource, id);
      for (const nested of libRelativeImportsOf(libSource, relPath)) {
        libQueue.push(resolveLibFile(nested));
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
    "/** @typedef {{ path: string; contents: string; owners?: string[] }} TemplateFile */",
    "",
    "/** @type {TemplateFile[]} */",
    "export const GENERATED_SEEDED_FILES = ",
  ].join("\n");
  return `${banner}${JSON.stringify(files, null, 2)};\n`;
}

function main() {
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
}

main();
