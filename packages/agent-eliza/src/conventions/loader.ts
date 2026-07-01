/**
 * Workflow loaders — discover and load workflow files from the filesystem.
 *
 * `loadWorkflowsFromDir` walks a directory for `.ts`/`.tsx`/`.js`/`.jsx` files,
 * dynamic-imports each one, reads its frontmatter, and builds `WorkflowDefinition`
 * objects.
 *
 * `loadWorkflows` aggregates across multiple sources (explicit paths, dirs)
 * and deduplicates by name (emitting collision diagnostics for conflicts).
 *
 * @module
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, extname, basename } from "node:path";
import { readFile } from "node:fs/promises";
import { parseWorkflowFrontmatter } from "./frontmatter.js";
import type {
  WorkflowDefinition,
  WorkflowDiagnostic,
  LoadWorkflowsResult,
  LoadWorkflowsOptions,
} from "./types.js";

const WORKFLOW_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);

/**
 * Dynamic-import a single workflow file and extract its `WorkflowDefinition`.
 *
 * The file must export a default export that is the Smithers workflow object
 * (the object with `.build` and `.opts`), or an object shaped like a
 * `WorkflowDefinition` (with a `.workflow` key holding the smithers object).
 *
 * Returns `null` if the file cannot be loaded or has no recognizable export.
 */
async function importWorkflowFile(
  filePath: string
): Promise<{ exported: unknown; source: string } | null> {
  try {
    const source = await readFile(filePath, "utf8");
    const mod = await import(filePath);
    const exported = mod.default ?? mod;
    return { exported, source };
  } catch {
    return null;
  }
}

/**
 * Derive a workflow slug name from a filename.
 * `close-issues.workflow.ts` → `close-issues`
 * `DeployProd.ts` → `deployprod`
 */
function nameFromFile(filePath: string): string {
  return basename(filePath)
    .replace(/\.(workflow|skill)\.(ts|tsx|js|jsx)$/, "")
    .replace(/\.(ts|tsx|js|jsx)$/, "")
    .toLowerCase();
}

/**
 * Build a `WorkflowDefinition` from an imported module value and its source.
 */
function buildDefinition(
  filePath: string,
  baseDir: string,
  exported: unknown,
  source: string
): WorkflowDefinition | null {
  const frontmatter = parseWorkflowFrontmatter(source);

  // If the export itself looks like a WorkflowDefinition (has .workflow), use it.
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
        (typeof frontmatter.description === "string"
          ? frontmatter.description
          : undefined) ??
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
      workflow: raw.workflow,
    };
  }

  // Otherwise treat the default export as the raw smithers workflow object.
  if (exported !== null && typeof exported === "object") {
    return {
      name:
        (typeof frontmatter.name === "string" ? frontmatter.name : undefined) ??
        nameFromFile(filePath),
      description:
        (typeof frontmatter.description === "string"
          ? frontmatter.description
          : undefined) ?? "",
      tags: frontmatter.tags as string[] | undefined,
      aliases: frontmatter.aliases as string[] | undefined,
      disableModelInvocation:
        typeof frontmatter["disable-model-invocation"] === "boolean"
          ? frontmatter["disable-model-invocation"]
          : undefined,
      filePath,
      baseDir,
      source,
      workflow: exported,
    };
  }

  return null;
}

/**
 * Load all workflows from a single directory.
 *
 * Walks the immediate children of `dir` (non-recursive), imports files with a
 * recognised extension, and returns the successfully loaded workflows plus any
 * diagnostics.
 */
export async function loadWorkflowsFromDir(
  dir: string
): Promise<LoadWorkflowsResult> {
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
        type: "warning",
        message: `Could not import workflow file: ${filePath}`,
        path: filePath,
      });
      continue;
    }

    const def = buildDefinition(filePath, dir, result.exported, result.source);
    if (!def) {
      diagnostics.push({
        type: "warning",
        message: `Workflow file has no recognizable export: ${filePath}`,
        path: filePath,
      });
      continue;
    }

    workflows.push(def);
  }

  return { workflows, diagnostics };
}

/**
 * Load workflows from multiple sources, deduplicating by name.
 *
 * Sources are processed in order. When two workflows share a name, the first
 * wins and a `collision` diagnostic is emitted for the second.
 */
export async function loadWorkflows(
  options: LoadWorkflowsOptions = {}
): Promise<LoadWorkflowsResult> {
  const { cwd = process.cwd(), workflowPaths = [], bundledDir, managedDir } =
    options;

  const allWorkflows: WorkflowDefinition[] = [];
  const allDiagnostics: WorkflowDiagnostic[] = [];

  // Helper to merge results into accumulators.
  function merge(result: LoadWorkflowsResult) {
    allDiagnostics.push(...result.diagnostics);
    for (const incoming of result.workflows) {
      const existing = allWorkflows.find((w) => w.name === incoming.name);
      if (existing) {
        allDiagnostics.push({
          type: "collision",
          message: `Workflow name collision: "${incoming.name}" (${existing.filePath ?? "in-memory"} vs ${incoming.filePath ?? "in-memory"})`,
          collision: { existing, incoming },
        });
      } else {
        allWorkflows.push(incoming);
      }
    }
  }

  // Load from explicit file paths.
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
    const def = buildDefinition(
      filePath,
      resolve(filePath, ".."),
      result.exported,
      result.source
    );
    if (!def) {
      allDiagnostics.push({
        type: "warning",
        message: `Workflow file has no recognizable export: ${filePath}`,
        path: filePath,
      });
      continue;
    }
    const existing = allWorkflows.find((w) => w.name === def.name);
    if (existing) {
      allDiagnostics.push({
        type: "collision",
        message: `Workflow name collision: "${def.name}"`,
        collision: { existing, incoming: def },
      });
    } else {
      allWorkflows.push(def);
    }
  }

  // Load from bundledDir.
  if (bundledDir) merge(await loadWorkflowsFromDir(resolve(cwd, bundledDir)));

  // Load from managedDir.
  if (managedDir) merge(await loadWorkflowsFromDir(resolve(cwd, managedDir)));

  return { workflows: allWorkflows, diagnostics: allDiagnostics };
}
