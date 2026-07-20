// @smithers-type-exports-begin
/**
 * @template D
 * @typedef {import("./InferDeps.ts").InferDeps<D>} InferDeps
 */
/** @typedef {import("./OutputTarget.ts").OutputTarget} OutputTarget */
// @smithers-type-exports-end

import { applyCliToolAllowlist } from "./cliToolAllowlist.js";
import { createTaskComponent } from "./taskCore.js";

export { renderPromptToText } from "./taskCore.js";

/**
 * The Node/CLI-agent-aware `Task`. Every render-path behavior (deps
 * resolution, agent-chain assembly, MDX prompt rendering, static/compute/agent
 * branching) lives in `taskCore.js`; this file only supplies the CLI-agent
 * tool-allowlist enforcement step (`applyCliToolAllowlist`, which statically
 * imports `ClaudeCodeAgent`/`PiAgent`/`GeminiAgent`/`AntigravityAgent` — see
 * `cliToolAllowlist.js`). `Task.browser.js` builds the same component with a
 * no-op allowlist step instead, so it never pulls those Node-only
 * (`node:child_process`-backed) classes into a browser bundle.
 */
export const Task = createTaskComponent({ applyCliToolAllowlist });
