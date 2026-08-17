/**
 * Load the review command only when invoked. Review brings its HTML renderer
 * and Mermaid graph stack, so ordinary CLI consumers should not install it.
 *
 * @param {() => Promise<any>} [load]
 */
export async function loadOptionalReviewCli(load = () => import("@smthrs/review/cli")) {
  try {
    return await load();
  } catch (error) {
    // Match on the message, not just ERR_MODULE_NOT_FOUND: Node and Bun both
    // name the missing specifier, and a bare code check would also fire when
    // the review package is installed but one of its own imports is missing,
    // which this install hint cannot fix.
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("@smthrs/review")) {
      throw new Error(
        "`smithers review` requires the optional @smthrs/review package. Install it with `npm install -D @smthrs/review` or `bun add -d @smthrs/review`, then retry.",
        { cause: error },
      );
    }
    throw error;
  }
}
