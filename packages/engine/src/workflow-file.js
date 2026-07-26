import { realpath } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import "./workflow-module-resolution.js";

/** @typedef {import("./ChildWorkflowFileRef.ts").ChildWorkflowFileRef} ChildWorkflowFileRef */
/** @typedef {import("@smithers-orchestrator/components/SmithersWorkflow").SmithersWorkflow<any>} AnySmithersWorkflow */

// Module formats a runtime-generated workflow file may ship as. Anything else
// (JSON, WASM, shell scripts, …) is rejected before it reaches the module
// loader.
const WORKFLOW_FILE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);

/**
 * True when a child workflow definition is a `{ path }` reference to a
 * workflow module file, as opposed to a built workflow object (which carries
 * a `build` function) or a factory function.
 *
 * @param {unknown} value
 * @returns {value is ChildWorkflowFileRef}
 */
export function isWorkflowFileRef(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (/** @type {{ path?: unknown }} */ (value).path) === "string" &&
    !("build" in value),
  );
}

/**
 * Load a runtime-generated workflow module file, enforcing that it lives
 * inside an approved root directory. Both the root and the file are
 * realpath-resolved so a symlink inside the root cannot smuggle in a module
 * from outside it. The module must default export a workflow built with
 * `smithers(...)` — the same contract the CLI enforces for workflow entry
 * files.
 *
 * @param {ChildWorkflowFileRef} ref
 * @param {{ approvedRoot?: string }} [opts]
 * @returns {Promise<{ workflow: AnySmithersWorkflow; path: string }>}
 */
export async function loadWorkflowFileRef(ref, opts = {}) {
  if (typeof ref.path !== "string" || ref.path.length === 0) {
    throw new SmithersError("INVALID_INPUT", "Workflow file reference requires a non-empty path.");
  }
  const approvedRoot = ref.approvedRoot ?? opts.approvedRoot;
  if (!approvedRoot) {
    throw new SmithersError(
      "INVALID_INPUT",
      `Workflow file ${ref.path} has no approved root: set approvedRoot on the reference or run the parent workflow with a rootDir.`,
      { path: ref.path },
    );
  }
  const rootAbs = resolve(approvedRoot);
  let realRoot;
  try {
    realRoot = await realpath(rootAbs);
  } catch (cause) {
    throw new SmithersError(
      "INVALID_INPUT",
      `Approved root ${rootAbs} for workflow file ${ref.path} does not exist.`,
      { path: ref.path, approvedRoot: rootAbs },
      cause,
    );
  }
  const fileAbs = resolve(rootAbs, ref.path);
  let realFile;
  try {
    realFile = await realpath(fileAbs);
  } catch (cause) {
    throw new SmithersError(
      "INVALID_INPUT",
      `Workflow file ${fileAbs} does not exist inside the approved root ${rootAbs}.`,
      { path: fileAbs, approvedRoot: rootAbs },
      cause,
    );
  }
  if (realFile !== realRoot && !realFile.startsWith(realRoot + sep)) {
    throw new SmithersError("INVALID_INPUT", `Workflow file ${fileAbs} escapes the approved root ${rootAbs}.`, {
      path: fileAbs,
      resolvedPath: realFile,
      approvedRoot: realRoot,
    });
  }
  const ext = extname(realFile);
  if (!WORKFLOW_FILE_EXTENSIONS.has(ext)) {
    throw new SmithersError(
      "INVALID_INPUT",
      `Workflow file ${fileAbs} has unsupported extension "${ext}". Expected one of: ${[...WORKFLOW_FILE_EXTENSIONS].join(", ")}.`,
      { path: realFile, extension: ext },
    );
  }
  const mod = await import(pathToFileURL(realFile).href);
  const workflow = mod?.default;
  if (!workflow) {
    throw new SmithersError(
      "WORKFLOW_MISSING_DEFAULT",
      `Workflow file ${realFile} must export default a workflow built with \`smithers(...)\`.`,
      { path: realFile },
    );
  }
  if (
    typeof workflow !== "object" ||
    typeof (/** @type {{ build?: unknown }} */ (workflow).build) !== "function" ||
    typeof (/** @type {{ opts?: unknown }} */ (workflow).opts) !== "object"
  ) {
    throw new SmithersError(
      "WORKFLOW_NOT_BUILT",
      `Workflow file ${realFile} default export must be created with \`smithers(...)\`. You exported a raw component or element.`,
      { path: realFile },
    );
  }
  return { workflow: /** @type {AnySmithersWorkflow} */ (workflow), path: realFile };
}
