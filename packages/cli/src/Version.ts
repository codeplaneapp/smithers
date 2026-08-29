/**
 * Package metadata used by the command-line entrypoint.
 *
 * @since 0.1.0
 */
import metadata from "@smthrs/cli/package.json" with { type: "json" }

if (typeof metadata.version !== "string") {
  throw new TypeError("@smthrs/cli package metadata does not declare a version")
}

/**
 * The version published in `@smthrs/cli` package metadata.
 *
 * @category configuration
 * @since 0.1.0
 * @slop
 */
export const packageVersion = metadata.version
