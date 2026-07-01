/**
 * Workflow loaders — discover and load workflow files from the filesystem.
 *
 * `loadWorkflowsFromDir` walks a directory, dynamic-imports each workflow file,
 * reads its `---` YAML frontmatter, and builds `WorkflowDefinition` objects.
 *
 * `loadWorkflows` aggregates across multiple sources with precedence ordering:
 * bundled < managed < project. Later sources override earlier ones on name
 * collision, and a `collision` diagnostic is emitted for each override.
 *
 * @module
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, extname, basename } from "node:path";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { parseWorkflowFrontmatter } from "./frontmatter.js";
import type {
  WorkflowDefinition,
  WorkflowDiagnostic,
  LoadWorkflowsResult,
  LoadWorkflowsOptions,
  WorkflowFrontmatter,
} from "./types.js";

const WORKFLOW_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);

/** Dynamic-import a workflow file. Returns null on failure — caller emits the diagnostic. */
async function importWorkflowFile(
  filePath: string
): Promise<{ exported: unknown; source: string } | null> {
  try {
    const mod = await import(filePath);
    const exported = mod.default ?? mod;
    // Read a companion .md file for frontmatter, falling back to the source file itself.
    const companionMd = filePath.replace(/\.(ts|tsx|js|jsx)$/, ".md");
    let source = "";
    try {
      source = await readFile(companionMd, "utf8");
    } catch {
      try {
        source = await readFile(filePath, "utf8");
      } catch {
        // ignore
      }
    }
    return { exported, source };
  } catch {
    return null;
  }
}

/** Derive a workflow slug name from a filename. */
function nameFromFile(filePath: string): string {
  return basename(filePath)
    .replace(/\.(workflow|skill)\.(ts|tsx|js|jsx)$/, "")
    .replace(/\.(ts|tsx|js|jsx)$/, "")
    .toLowerCase();
}

/** Build a WorkflowDefinition from an imported module and its source. */
function buildDefinition(
  filePath: string,
  baseDir: string,
  exported: unknown,
  source: string,
  fm?: WorkflowFrontmatter
): WorkflowDefinition | null {
  const { frontmatter } = fm !== undefined ? { frontmatter: fm } : parseWorkflowFrontmatter(source);

  if (
    exported !== null &&
    typeof exported === "object" &&
    "workflow" in (exported as object)
  ) {
    const raw = exported as Partial<WorkflowDefinition>;
    return {
      name:
        raw.name ??
        (typeof frontmatter.name === "string" ? frontmatter.name : undefined) ??
        nameFromFile(filePath),
      description:
        raw.description ??
        (typeof frontmatter.description === "string" ? frontmatter.description : undefined) ??
        "",
      tags: raw.tags ?? (frontmatter.tags as string[] | undefined),
      aliases: raw.aliases ?? (frontmatter.aliases as string[] | undefined),
      disableModelInvocation:
        raw.disableModelInvocation ??
        (typeof frontmatter["disable-model-invocation"] === "boolean"
          ? frontmatter["disable-model-invocation"]
          : undefined),
      filePath,
      baseDir,
      source,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      workflow: raw.workflow as any,
    };
  }

  if (exported !== null && typeof exported === "object") {
    return {
      name:
        (typeof frontmatter.name === "string" ? frontmatter.name : undefined) ??
        nameFromFile(filePath),
      description:
        (typeof frontmatter.description === "string" ? frontmatter.description : undefined) ?? "",
      tags: frontmatter.tags as string[] | undefined,
      aliases: frontmatter.aliases as string[] | undefined,
      disableModelInvocation:
        typeof frontmatter["disable-model-invocation"] === "boolean"
          ? frontmatter["disable-model-invocation"]
          : undefined,
      filePath,
      baseDir,
      source,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      workflow: exported as any,
    };
  }

  return null;
}

/**
 * Load all workflows from a single directory.
 *
 * @param options.dir - Absolute path to the directory to scan.
 * @param options.source - Human-readable source label for diagnostics (e.g. "project", "bundled").
 */
export async function loadWorkflowsFromDir({
  dir,
  source = "unknown",
}: {
  dir: string;
  source?: string;
}): Promise<LoadWorkflowsResult> {
  const workflows: WorkflowDefinition[] = [];
  const diagnostics: WorkflowDiagnostic[] = [];

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

    const result = await importWorkflowFile(filePath);
    if (!result) {
      diagnostics.push({
        type: "error",
        message: `Could not import workflow file (${source}): ${filePath}`,
        path: filePath,
      });
      continue;
    }

    const def = buildDefinition(filePath, dir, result.exported, result.source);
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
 */
export async function loadWorkflows(
  options: LoadWorkflowsOptions = {}
): Promise<LoadWorkflowsResult> {
  const {
    cwd = process.cwd(),
    workflowPaths = [],
    includeDefaults = true,
    bundledDir,
    managedDir,
  } = options;

  /** name → definition map; later sources overwrite earlier. */
  const byName = new Map<string, WorkflowDefinition>();
  const allDiagnostics: WorkflowDiagnostic[] = [];

  function mergeIn(incoming: WorkflowDefinition) {
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

  async function loadDir(dir: string, source: string) {
    const result = await loadWorkflowsFromDir({ dir, source });
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
    const result = await importWorkflowFile(filePath);
    if (!result) {
      allDiagnostics.push({
        type: "error",
        message: `Could not import workflow file: ${filePath}`,
        path: filePath,
      });
      continue;
    }
    const def = buildDefinition(filePath, resolve(filePath, ".."), result.exported, result.source);
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
