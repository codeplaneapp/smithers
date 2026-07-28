// smithers-source: local
// smithers-metadata-version: 1
// smithers-display-name: Federation Workflow Hardening Two
// smithers-description: Close remaining execution and release-safety gaps in the repository-federation workflow.
// smithers-tags: maintenance, federation, safety
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";

const resultSchema = z.object({
  summary: z.string(),
  filesChanged: z.array(z.string()).default([]),
  corrections: z.array(z.string()).default([]),
  graphPassing: z.boolean(),
  uiBuildPassing: z.boolean(),
});

const { Workflow, Task, smithers, outputs } = createSmithers({ result: resultSchema });

export default smithers(() => (
  <Workflow name="federation-workflow-hardening-2">
    <Task
      id="harden"
      output={outputs.result}
      agent={agents.migrationHard}
      timeoutMs={60 * 60_000}
      heartbeatTimeoutMs={20 * 60_000}
    >
      {`
Second hard safety pass. Edit only:
- .smithers/workflows/smithers-repo-federation.tsx
- .smithers/prompts/federation-*.mdx
- .smithers/ui/smithers-repo-federation.tsx

The first pass removed private repos, live-checkout Worktree components, force
pushes, generic agents.planning, and moved the final Ralph loop before publish.
Preserve those fixes. Close every remaining defect below:

1. prepareRoot must fail the task on an invalid root, clone/fetch a clean
   origin/main source clone under migrationRoot, and make inventory, extraction,
   and kernel work read that clone. Never inventory or clone from the dirty live
   checkout.
2. Architecture/DAG judgment must run on agents.migrationHard. Sol
   agents.migrationReview is for verification/review, especially the final Ralph.
3. multi and plue must actually receive their source-owned browser-UI and hosted
   control-plane/electric-proxy paths with preserved source history. A PR lane
   cannot merely clone the target and change dependency ranges: create a temporary
   filtered source-history clone, merge/subtree it into the target feature branch
   without rewriting target main, then adapt it. awesome-smithers is docs-only.
4. createRepos must be idempotent only for repos recorded as created by this
   migration. A pre-existing unrecorded destination name is a hard stop before
   lane work. Lane execution must structurally require all ten PUBLIC repos ready.
5. pushNewRepoLane must set and verify origin to the exact destination before
   pushing; it must never retain/fall back to the source origin. Verify PUBLIC
   visibility and set/verify default branch main after the first push.
6. Model each repository as potentially containing zero, one, or many publishable
   npm packages. Inventory must emit a release-plan artifact with package
   paths/names/versions and repository dependencies. Examples/apps may need only
   a GitHub release. Per-repo release scripts and the smithers root coordinator
   consume the release plan. Do not call npm publish once at every repository
   root. Dry-run every publishable package and the root aggregate coordinator.
   Actual publication must invoke that validated coordinator in DAG order and
   create tags/GitHub releases for every repo.
7. Existing-repo validation may use local packed artifacts/workspace links before
   publication, but committed manifests must use published semver.
8. prepareRoot/createRepos/push/PR/release helper failures must throw or expose an
   explicit ready=false that structurally blocks downstream side effects; never
   catch an error and continue with a success-shaped row.
9. Keep exactly ten new PUBLIC repos plus multi/plue/awesome-smithers, exactly
   three approvals (manifest, publish, merge), exact pools migrationEasy,
   migrationHard, migrationReview, both lockfiles, history/LICENSE, docs/llms/
   skills/plugin copies/awesome-smithers/stale links/aggregate tests, and the
   custom UI.
10. Add a post-publication/post-merge agents.migrationReview verification at the
    true end, in addition to the pre-publication Ralph safety loop, so Sol reviews
    the landed state before the terminal report can say complete.

Validate:
  bun apps/cli/src/index.js graph .smithers/workflows/smithers-repo-federation.tsx
  bun build --no-bundle .smithers/ui/smithers-repo-federation.tsx

REQUIRED OUTPUT:
{
  "summary": "what was hardened",
  "filesChanged": ["exact paths"],
  "corrections": ["specific fixes"],
  "graphPassing": true,
  "uiBuildPassing": true
}
`}
    </Task>
  </Workflow>
));
