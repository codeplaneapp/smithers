import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const STATIC_IMPORT_RE = /\b(?:import|export)\s+(?:[^"'`]*?\s+from\s*)?["']([^"']+)["']/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
const EXTENSIONS = ["", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function importSpecifiers(source, sourcePath) {
  if (typeof Bun !== "undefined" && typeof Bun.Transpiler === "function") {
    try {
      const lower = sourcePath.toLowerCase();
      const loader = lower.endsWith(".tsx")
        ? "tsx"
        : lower.endsWith(".jsx")
          ? "jsx"
          : lower.endsWith(".ts") || lower.endsWith(".mts") || lower.endsWith(".cts")
            ? "ts"
            : "js";
      const specifiers = new Set();
      for (const entry of new Bun.Transpiler({ loader }).scanImports(source)) {
        const specifier = entry?.path?.trim();
        if (specifier?.startsWith(".")) specifiers.add(specifier);
      }
      return [...specifiers];
    } catch {
      // Match the resume hash implementation's regex fallback.
    }
  }
  const specifiers = new Set();
  for (const pattern of [STATIC_IMPORT_RE, DYNAMIC_IMPORT_RE]) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const specifier = match[1]?.trim();
      if (specifier?.startsWith(".")) specifiers.add(specifier);
    }
  }
  return [...specifiers];
}

function resolveImport(baseFile, specifier) {
  const basePath = resolve(dirname(baseFile), specifier);
  const candidates = [
    ...EXTENSIONS.map((extension) => `${basePath}${extension}`),
    ...EXTENSIONS.filter(Boolean).map((extension) => resolve(basePath, `index${extension}`)),
  ];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null;
}

async function collectGraphEntries(workflowPath, visited = new Set()) {
  const resolvedPath = resolve(workflowPath);
  if (visited.has(resolvedPath)) return [];
  visited.add(resolvedPath);
  const source = await readFile(resolvedPath, "utf8");
  const entries = [`${resolvedPath}:${sha256(source)}`];
  for (const specifier of importSpecifiers(source, resolvedPath)) {
    const importedPath = resolveImport(resolvedPath, specifier);
    if (!importedPath) throw new Error(`Unable to resolve ${specifier} from ${resolvedPath}.`);
    entries.push(...await collectGraphEntries(importedPath, visited));
  }
  return entries;
}

function durabilityMetadata(configJson) {
  if (!configJson) return null;
  try {
    const config = JSON.parse(configJson);
    const value = config?.__smithersDurability;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return {
      version: typeof value.version === "number" ? value.version : 0,
      entryWorkflowHash: typeof value.entryWorkflowHash === "string"
        ? value.entryWorkflowHash
        : null,
    };
  } catch {
    return null;
  }
}

/**
 * Validate the current workflow source against the same persisted entry and
 * module-graph hashes used by resume. Missing identity is a mismatch because
 * compensation handlers must never be guessed.
 *
 * @param {{ workflowPath?: string | null; workflowHash?: string | null; configJson?: string | null }} run
 * @returns {Promise<boolean>}
 */
export async function validateWorkflowIdentity(run) {
  if (!run.workflowPath || !run.workflowHash) return false;
  try {
    const resolvedPath = resolve(run.workflowPath);
    const source = await readFile(resolvedPath, "utf8");
    const entryWorkflowHash = sha256(source);
    const durability = durabilityMetadata(run.configJson);
    if ((durability?.version ?? 0) >= 2) {
      if (!durability?.entryWorkflowHash) return false;
      const graphEntries = await collectGraphEntries(resolvedPath);
      const workflowHash = sha256(graphEntries.sort().join("|"));
      return run.workflowHash === workflowHash
        && durability.entryWorkflowHash === entryWorkflowHash;
    }
    return run.workflowHash === entryWorkflowHash;
  } catch {
    return false;
  }
}
