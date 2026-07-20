import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";

const STATIC_IMPORT_RE = /\b(?:import|export)\s+(?:[^"'`]*?\s+from\s*)?["']([^"']+)["']/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
const WORKFLOW_IMPORT_EXTENSIONS = [
    "",
    ".ts",
    ".tsx",
    ".mts",
    ".cts",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
];

/**
 * @param {string} input
 * @returns {string}
 */
export function sha256Hex(input) {
    return createHash("sha256").update(input).digest("hex");
}

/**
 * @param {string | null | undefined} sourcePath
 */
export function getWorkflowImportScanLoader(sourcePath) {
    const lower = sourcePath?.toLowerCase() ?? "";
    if (lower.endsWith(".tsx"))
        return "tsx";
    if (lower.endsWith(".jsx"))
        return "jsx";
    if (lower.endsWith(".ts") ||
        lower.endsWith(".mts") ||
        lower.endsWith(".cts")) {
        return "ts";
    }
    return "js";
}

/**
 * @param {string | null} workflowPath
 * @returns {Promise<string | null>}
 */
export async function readWorkflowEntryHash(workflowPath) {
    if (!workflowPath)
        return null;
    try {
        const raw = await readFile(workflowPath, "utf8");
        return sha256Hex(raw);
    }
    catch {
        return null;
    }
}

/**
 * @param {string} source
 * @param {string | null} [sourcePath]
 * @returns {string[]}
 */
export function extractWorkflowImportSpecifiers(source, sourcePath) {
    if (typeof Bun !== "undefined" && typeof Bun.Transpiler === "function") {
        try {
            const scanned = new Bun.Transpiler({
                loader: getWorkflowImportScanLoader(sourcePath),
            }).scanImports(source);
            const specifiers = new Set();
            for (const entry of scanned) {
                const specifier = entry?.path?.trim();
                if (specifier?.startsWith(".")) {
                    specifiers.add(specifier);
                }
            }
            return [...specifiers];
        }
        catch {
            // Fall back to regex scanning if Bun's parser cannot handle the source.
        }
    }
    const specifiers = new Set();
    for (const pattern of [STATIC_IMPORT_RE, DYNAMIC_IMPORT_RE]) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(source)) !== null) {
            const specifier = match[1]?.trim();
            if (!specifier?.startsWith("."))
                continue;
            specifiers.add(specifier);
        }
    }
    return [...specifiers];
}

/**
 * @param {string} baseFile
 * @param {string} specifier
 * @returns {string | null}
 */
export function resolveWorkflowImport(baseFile, specifier) {
    const basePath = resolve(dirname(baseFile), specifier);
    const candidates = [
        ...WORKFLOW_IMPORT_EXTENSIONS.map((ext) => `${basePath}${ext}`),
        ...WORKFLOW_IMPORT_EXTENSIONS
            .filter((ext) => ext.length > 0)
            .map((ext) => resolve(basePath, `index${ext}`)),
    ];
    for (const candidate of candidates) {
        if (existsSync(candidate) && statSync(candidate).isFile()) {
            return resolve(candidate);
        }
    }
    return null;
}

/**
 * @param {string} workflowPath
 * @returns {Promise<string[]>}
 */
async function collectWorkflowModuleHashEntries(workflowPath, visited = new Set()) {
    const resolvedPath = resolve(workflowPath);
    if (visited.has(resolvedPath)) {
        return [];
    }
    visited.add(resolvedPath);
    const source = await readFile(resolvedPath, "utf8");
    const entries = [`${resolvedPath}:${sha256Hex(source)}`];
    for (const specifier of extractWorkflowImportSpecifiers(source, resolvedPath)) {
        const importedPath = resolveWorkflowImport(resolvedPath, specifier);
        if (!importedPath) {
            throw new SmithersError("WORKFLOW_HASH_RESOLUTION_FAILED", `Unable to resolve workflow import "${specifier}" from ${resolvedPath}.`, { workflowPath: resolvedPath, specifier });
        }
        entries.push(...(await collectWorkflowModuleHashEntries(importedPath, visited)));
    }
    return entries;
}

/**
 * @param {string | null} workflowPath
 * @returns {Promise<string | null>}
 */
export async function readWorkflowGraphHash(workflowPath) {
    if (!workflowPath)
        return null;
    try {
        const entries = await collectWorkflowModuleHashEntries(workflowPath);
        return sha256Hex(entries.sort().join("|"));
    }
    catch {
        return null;
    }
}
