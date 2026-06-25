import { basename, resolve } from "node:path";

/**
 * @param {string} workflowPath
 * @param {string | undefined} out
 * @returns {string}
 */
export function resolveClaudeWorkflowOutputPath(workflowPath, out) {
    if (out && out.trim().length > 0) {
        return resolve(process.cwd(), out);
    }
    const base = basename(workflowPath).replace(/\.[^.]+$/, "");
    return resolve(process.cwd(), ".claude", "workflows", `${base}-mirror.mjs`);
}
