/**
 * Workflow loaders — discover and load workflow files from the filesystem.
 *
 * `loadWorkflowsFromDir` walks a directory, reads frontmatter from each workflow
 * file's text FIRST (before dynamic import), then dynamic-imports the module.
 *
 * Frontmatter for executable files (.ts/.tsx/.js/.mjs) must live in a leading
 * block comment: `/* ---\n...yaml...\n--- *\/`. Raw `---` YAML at the top of an
 * executable file is not valid JS/TS syntax. Companion `.md` files may use plain
 * `---`-fenced YAML frontmatter.
 *
 * `loadWorkflows` aggregates across multiple sources with precedence ordering:
 * bundled < managed < project. Later sources override earlier ones on name
 * collision, and a `collision` diagnostic is emitted for each override.
 *
 * @module
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, extname, basename, dirname } from "node:path";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { parseWorkflowFrontmatter } from "./frontmatter.js";

/** @typedef {import("./types.js").WorkflowDefinition} WorkflowDefinition */
/** @typedef {import("./types.js").WorkflowDiagnostic} WorkflowDiagnostic */
/** @typedef {import("./types.js").LoadWorkflowsResult} LoadWorkflowsResult */
/** @typedef {import("./types.js").LoadWorkflowsOptions} LoadWorkflowsOptions */
/** @typedef {import("./types.js").WorkflowFrontmatter} WorkflowFrontmatter */

const WORKFLOW_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs"]);

/**
 * Read the executable workflow file's own source text.
 *
 * This is what populates `WorkflowDefinition.source` — the raw text of the
 * executable file itself, never a companion `.md`, so consumers that hash or
 * re-parse `source` operate on the real workflow module.
 *
 * @param {string} filePath
 * @returns {Promise<string>}
 */
async function readExecutableSource(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

/**
 * Read the source text used for frontmatter parsing.
 * Prefers a companion `.md` (pure `---` YAML) when present, otherwise falls
 * back to the executable file's own text (block-comment frontmatter). The
 * already-read `execSource` is reused for the fallback to avoid a second read.
 *
 * @param {string} filePath
 * @param {string} execSource - the executable file's own source, already read.
 * @returns {Promise<string>}
 */
async function readSourceForFrontmatter(filePath, execSource) {
  const companionMd = filePath.replace(/\.(ts|tsx|js|jsx|mjs)$/, ".md");
  try {
    return await readFile(companionMd, "utf8");
  } catch {
    return execSource;
  }
}

/**
 * Dynamic-import a workflow file. Returns null on failure — caller emits the diagnostic.
 *
 * @param {string} filePath
 * @returns {Promise<unknown | null>}
 */
async function importWorkflowFile(filePath) {
  try {
    const mod = await import(filePath);
    return mod.default ?? mod;
  } catch {
    return null;
  }
}

/** Derive a workflow slug name from a filename.
 * @param {string} filePath
 * @returns {string}
 */
function nameFromFile(filePath) {
  return basename(filePath)
    .replace(/\.(workflow|skill)\.(ts|tsx|js|jsx|mjs)$/, "")
    .replace(/\.(ts|tsx|js|jsx|mjs)$/, "")
    .toLowerCase();
}

/**
 * Build a WorkflowDefinition from an imported module, its source text, and
 * pre-parsed frontmatter.
 *
 * @param {string} filePath
 * @param {string} baseDir
 * @param {unknown} exported
 * @param {string} source
 * @param {WorkflowFrontmatter} frontmatter
 * @returns {WorkflowDefinition | null}
 */
function buildDefinition(filePath, baseDir, exported, source, frontmatter) {
  if (exported === null || typeof exported !== "object") return null;

  // Two accepted module shapes: a WorkflowDefinition-like object carrying a
  // `workflow` field (its own fields win over frontmatter), or a bare workflow
  // object (all metadata then comes from frontmatter).
  const hasWorkflowExport = "workflow" in exported;
  const raw = /** @type {Partial<WorkflowDefinition>} */ (hasWorkflowExport ? exported : {});

  return {
    name:
      raw.name ??
      (typeof frontmatter.name === "string" ? frontmatter.name : undefined) ??
      nameFromFile(filePath),
    description:
      raw.description ??
      (typeof frontmatter.description === "string" ? frontmatter.description : undefined) ??
      "",
    tags: raw.tags ?? /** @type {string[] | undefined} */ (frontmatter.tags),
    aliases: raw.aliases ?? /** @type {string[] | undefined} */ (frontmatter.aliases),
    disableModelInvocation:
      raw.disableModelInvocation ??
      (typeof frontmatter["disable-model-invocation"] === "boolean"
        ? frontmatter["disable-model-invocation"]
        : undefined),
    system:
      raw.system ??
      (typeof frontmatter.system === "boolean" ? frontmatter.system : undefined),
    version:
      raw.version ??
      (typeof frontmatter.version === "string" ? frontmatter.version : undefined),
    filePath,
    baseDir,
    source,
    workflow: /** @type {any} */ (hasWorkflowExport ? raw.workflow : exported),
  };
}

/**
 * Load all workflows from a single directory.
 *
 * @param {{ dir: string; source?: string }} options
 * @returns {Promise<LoadWorkflowsResult>}
 */
export async function loadWorkflowsFromDir({ dir, source = "unknown" }) {
  /** @type {WorkflowDefinition[]} */
  const workflows = [];
  /** @type {WorkflowDiagnostic[]} */
  const diagnostics = [];

  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    diagnostics.push({
      type: "warning",
      message: `loadWorkflowsFromDir: directory does not exist: ${dir}`,
      path: dir,
    });
    return { workflows, diagnostics };
  }

  const entries = readdirSync(dir);
  for (const entry of entries) {
    const filePath = join(dir, entry);
    if (!statSync(filePath).isFile()) continue;
    if (!WORKFLOW_EXTENSIONS.has(extname(entry))) continue;

    // Read source text and parse frontmatter BEFORE dynamic import. The
    // executable file's own text is the `source`; frontmatter may come from a
    // companion `.md` instead.
    const execSource = await readExecutableSource(filePath);
    const frontmatterSource = await readSourceForFrontmatter(filePath, execSource);
    const { frontmatter } = parseWorkflowFrontmatter(frontmatterSource);

    const exported = await importWorkflowFile(filePath);
    if (exported === null) {
      diagnostics.push({
        type: "error",
        message: `Could not import workflow file (${source}): ${filePath}`,
        path: filePath,
      });
      continue;
    }

    const def = buildDefinition(filePath, dir, exported, execSource, frontmatter);
    if (!def) {
      diagnostics.push({
        type: "error",
        message: `Workflow file has no recognizable export (${source}): ${filePath}`,
        path: filePath,
      });
      continue;
    }

    workflows.push(def);
  }

  return { workflows, diagnostics };
}

/**
 * Load workflows from multiple sources, deduplicating by name with precedence ordering.
 *
 * Sources are processed lowest-to-highest precedence:
 *   bundledDir < managedDir (~/.smithers/workflows) < <cwd>/.smithers/workflows
 *
 * When two workflows share a name, the higher-precedence (later) source wins and
 * a `collision` diagnostic is emitted.
 *
 * @param {LoadWorkflowsOptions} [options]
 * @returns {Promise<LoadWorkflowsResult>}
 */
export async function loadWorkflows(options = {}) {
  const {
    cwd = process.cwd(),
    workflowPaths = [],
    includeDefaults = true,
    bundledDir,
    managedDir,
  } = options;

  /** @type {Map<string, WorkflowDefinition>} */
  const byName = new Map();
  /** @type {WorkflowDiagnostic[]} */
  const allDiagnostics = [];

  /** @param {WorkflowDefinition} incoming */
  function mergeIn(incoming) {
    const existing = byName.get(incoming.name);
    if (existing) {
      allDiagnostics.push({
        type: "collision",
        message: `Workflow name collision: "${incoming.name}" — ${incoming.filePath ?? "in-memory"} overrides ${existing.filePath ?? "in-memory"}`,
        collision: { existing, incoming },
      });
    }
    byName.set(incoming.name, incoming);
  }

  /**
   * @param {string} dir
   * @param {string} src
   */
  async function loadDir(dir, src) {
    const result = await loadWorkflowsFromDir({ dir, source: src });
    allDiagnostics.push(...result.diagnostics);
    for (const w of result.workflows) mergeIn(w);
  }

  // Lowest precedence: bundled defaults.
  if (bundledDir) await loadDir(resolve(cwd, bundledDir), "bundled");

  // Middle precedence: standard managed dir (~/.smithers/workflows).
  if (includeDefaults) {
    const defaultManaged = join(homedir(), ".smithers", "workflows");
    const managed = managedDir ? resolve(cwd, managedDir) : defaultManaged;
    if (existsSync(managed)) await loadDir(managed, "managed");
  } else if (managedDir) {
    await loadDir(resolve(cwd, managedDir), "managed");
  }

  // Explicit workflowPaths — processed before project dir but after managed.
  for (const rawPath of workflowPaths) {
    const filePath = resolve(cwd, rawPath);

    const execSource = await readExecutableSource(filePath);
    const frontmatterSource = await readSourceForFrontmatter(filePath, execSource);
    const { frontmatter } = parseWorkflowFrontmatter(frontmatterSource);

    const exported = await importWorkflowFile(filePath);
    if (exported === null) {
      allDiagnostics.push({
        type: "error",
        message: `Could not import workflow file: ${filePath}`,
        path: filePath,
      });
      continue;
    }
    const def = buildDefinition(filePath, dirname(filePath), exported, execSource, frontmatter);
    if (!def) {
      allDiagnostics.push({
        type: "error",
        message: `Workflow file has no recognizable export: ${filePath}`,
        path: filePath,
      });
      continue;
    }
    mergeIn(def);
  }

  // Highest precedence: project .smithers/workflows.
  if (includeDefaults) {
    const projectDir = join(cwd, ".smithers", "workflows");
    if (existsSync(projectDir)) await loadDir(projectDir, "project");
  }

  return { workflows: Array.from(byName.values()), diagnostics: allDiagnostics };
}
