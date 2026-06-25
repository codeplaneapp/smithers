import { claudeWorkflowTemplate } from "./claudeWorkflowTemplate.js";

/**
 * @param {import("./ClaudeWorkflowGeneratorOptions.ts").ClaudeWorkflowGeneratorOptions} options
 * @returns {string}
 */
export function emitClaudeWorkflowMirror(options) {
    return claudeWorkflowTemplate(options);
}
