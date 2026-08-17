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
    const code = /** @type {{ code?: string }} */ (error)?.code;
    const message = error instanceof Error ? error.message : String(error);
    if (code === "ERR_MODULE_NOT_FOUND" || message.includes("@smthrs/review")) {
      throw new Error(
        "`smithers review` requires the optional @smthrs/review package. Install it with `npm install -D @smthrs/review` or `bun add -d @smthrs/review`, then retry.",
        { cause: error },
      );
    }
    throw error;
  }
}
