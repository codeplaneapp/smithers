/**
 * Targets for this repository's own flows and the migration pack inputs.
 *
 * `flows/` is the project flow directory the CLI discovers, so its contents are
 * product surface rather than fixtures: the ten prompt bodies are read by the
 * registry, and the 0.x fixture beside them is read by the migration detector.
 * This gate runs both through their production entry points.
 */
import { Smithers } from "@smthrs/targets"

/**
 * The prompt bodies load through `@smthrs/registry` with no warnings, discovery
 * finds exactly them, and the 0.x fixture is detected as a 0.x project.
 *
 * @since 0.1.0
 * @category test
 */
const pack = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//flows/pack.test.mjs")]),
  srcs: [Smithers.glob("//flows/**/flow.mdx")],
  deps: []
})

export const Package = Smithers.Package({
  targets: { pack }
})
