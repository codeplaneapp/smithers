/**
 * `@smthrs/agent-eliza/conventions`
 *
 * elizaOS-conventions authoring layer for Smithers workflows.
 *
 * Lets someone who knows elizaOS conventions author, load, and register
 * Smithers workflows using the same shapes and function names elizaOS uses
 * for Skills/Plugins.
 *
 * @module
 */

export {
  parseWorkflowFrontmatter,
  stripFrontmatter,
  serializeWorkflowFile,
  serializeWorkflowFrontmatter,
} from "./frontmatter.js";

export { defineWorkflow, defineWorkflowPlugin } from "./define.js";

export { loadWorkflowsFromDir, loadWorkflows } from "./loader.js";

export { formatWorkflowsForPrompt } from "./formatter.js";

export { registerWorkflows, toSkill, pluginToElizaPlugin } from "./register.js";
