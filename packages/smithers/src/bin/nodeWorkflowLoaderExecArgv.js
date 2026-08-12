/**
 * Node arguments that install the CLI's TypeScript/JSX module loader in a child
 * process, for use ahead of the script path in a `spawn(process.execPath, ...)`.
 *
 * Empty under Bun, which transpiles those files itself and does not accept
 * `--import`.
 *
 * @returns {string[]}
 */
export function nodeWorkflowLoaderExecArgv() {
  if (typeof Bun !== "undefined") return [];
  try {
    return ["--import", import.meta.resolve("@smthrs/cli/node-loader/register")];
  } catch {
    // A checkout without @smthrs/cli installed still delegates; it will fail
    // later with its own, clearer error than a resolution failure here.
    return [];
  }
}
