/**
 * Lazy access to the style-guide theme CSS.
 *
 * `@smthrs/ui-styleguide` publishes raw TypeScript, as does every package in
 * the browser UI tier (`gateway-client`, `gateway-react`, `gateway-ui`, `ui`,
 * `ui-core`, `tui-ui`, `pi-plugin`). Those packages reach a browser through the
 * gateway's `Bun.build` step, which reads TypeScript directly, so they never
 * need a compiled artifact.
 *
 * Node refuses every `.ts` file under a `node_modules` directory
 * (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), which is exactly where an
 * installed smthrs lives. `@smthrs/server` is a Node-tier package, so importing
 * the style guide at module load put a file Node cannot parse in the runtime
 * graph of the smthrs entry point, and broke importing the library before any
 * Smithers code ran.
 *
 * Resolving the CSS on demand keeps the boundary honest: importing the library,
 * the CLI, and a booted gateway never touch the style guide, while the UI
 * request paths that do need it already require Bun for
 * `bundleGatewayUiEntry`.
 */

/** @type {Promise<string> | null} */
let pending = null;

/**
 * Resolve the workflow UI theme CSS, importing the style guide on first use.
 *
 * @returns {Promise<string>}
 */
export function loadWorkflowUiThemeCss() {
  pending ??= import("@smthrs/ui-styleguide").then((module) => module.workflowUiThemeCss);
  return pending;
}
