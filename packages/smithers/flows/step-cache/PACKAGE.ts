/** Standard package targets plus package-owned documentation generation. */
import { Smithers } from "@smthrs/targets"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = Smithers.StandardPackage({
  deps: [],
  cwd: "packages/smithers/flows/step-cache"
})

/**
 * The durable-identity review: identity strings, migrations, persisted
 * schemas, and durable keys, read out of this package's own changed sources.
 *
 * @since 0.1.0
 * @category lint
 */
const durableIdentityGuard = Smithers.DurableIdentityGuard({ cwd: "packages/smithers/flows/step-cache" })

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsFiles, durableIdentityGuard, fmt, lib, lint, test }
})
