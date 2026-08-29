/**
 * Select generator arguments for `check:llms`.
 *
 * Versioned artifacts are immutable after a release tag or publication.
 * Before release, they are generated and compared like every other committed
 * bundle.
 *
 * @param {"published" | "unpublished" | "unavailable"} publication
 * @param {string} version
 * @returns {string[]}
 */
export function versionedGeneratorArgs(publication, version) {
  if (publication === "published") return ["--skip-versioned"];
  if (publication === "unpublished") return [];
  throw new Error(
    `Could not verify whether smthrs@${version} is published; ` + "refusing to skip versioned llms artifacts.",
  );
}
