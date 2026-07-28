// smithers-source: local
// smithers-metadata-version: 1
// smithers-display-name: Federation Manifest Hardening
// smithers-description: Repair and validate the Smithers federation ownership manifest, release DAG, and clean-snapshot review safety.
// smithers-tags: maintenance, federation, safety
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";

const resultSchema = z.object({
  summary: z.string(),
  filesChanged: z.array(z.string()).default([]),
  pathCoverageExact: z.boolean(),
  dagAcyclic: z.boolean(),
  marketingOverlapRemoved: z.boolean(),
  reviewPinnedToCleanClone: z.boolean(),
  graphPassing: z.boolean(),
  uiBuildPassing: z.boolean(),
  remainingRisks: z.array(z.string()).default([]),
});

const { Workflow, Task, smithers, outputs } = createSmithers({ result: resultSchema });

export default smithers(() => (
  <Workflow name="federation-manifest-hardening">
    <Task
      id="harden"
      output={outputs.result}
      agent={agents.migrationHard}
      timeoutMs={60 * 60_000}
      heartbeatTimeoutMs={20 * 60_000}
    >
      {`
Repair the Smithers repository-federation manifest and the workflow that
consumes it. This is implementation work, not a review.

AUTHORITATIVE SNAPSHOT:
  /Users/williamcory/smithers-federation-migration-20260727/source-clone
ARTIFACTS:
  /Users/williamcory/smithers-federation-migration-20260727/artifacts

Hard safety:
- Inspect source code, git history, manifests, and imports ONLY inside the
  authoritative source-clone. NEVER read or inspect /Users/williamcory/smithers
  except for the exact workflow/prompt/UI files you are allowed to edit below.
  The live checkout is dirty and concurrently changing, so it is not evidence.
- Write only the three artifact JSON files and these workflow assets:
  .smithers/workflows/smithers-repo-federation.tsx
  .smithers/prompts/federation-*.mdx
  .smithers/ui/smithers-repo-federation.tsx
  Do not mutate source-clone or GitHub.

Fix every blocker:

1. manifest.json must contain exactly one entry for every path from
   \`git -C <source-clone> ls-files\`: 8,834 unique paths, no missing paths,
   duplicates, or paths inferred from the dirty live checkout.

2. Another concurrent migration owns all marketing material. Reassign every
   \`marketing/**\` path to \`stays-in-smithers\` for this federation run with a
   note that it is intentionally untouched pending the external marketing
   migration. Remove marketing package records from smithers-examples.

3. Resolve ownership using actual clean-snapshot imports. Keep the approved
   destinations exactly:
   smithers-examples, smithers-agents, smithers-sandboxes,
   smithers-integrations, smithers-plugins, smithers-packs,
   smithers-observability, smithers-review, smithers-evals, smithers-signal;
   existing history-merge targets multi and plue; docs-only awesome-smithers;
   and stays-in-smithers.
   Agent contracts/adapters belong in smithers-agents. Browser UI belongs in
   multi. Hosted control-plane/electric-proxy belongs in plue. Curate
   \`.smithers\`: do not blindly move repo-local tickets/state/audits/generated
   developer artifacts as a reusable pack. A path may stay in Smithers while a
   later decoupling step changes how the CLI obtains external packs.
   \`apps/cli/src/openclaw-plugin\` may move to smithers-plugins only if the
   manifest/DAG/release plan explicitly models the CLI's later semver rewire.

4. Replace the cyclic raw workspace graph with an executable, machine-readable
   release plan. Distinguish initial federation publication from future
   aggregate publication:
   - core Smithers packages already published are external semver prerequisites
     for the ten new repos;
   - the initial new-repo DAG must be acyclic and order only real dependencies
     among the ten new repos;
   - the Smithers facade is a final/meta publication in future aggregate runs,
     never an upstream prerequisite that creates a cycle;
   - multi/plue are existing PR targets. Model their moved packages and future
     aggregate release participation explicitly without trying to publish
     unmerged feature-branch code during the initial new-repo release;
   - awesome-smithers is docs-only and never npm-published.
   Add explicit waves/scopes/prerequisites if needed. Ensure the root release
   coordinator and dry-run prompts consume the same semantics.

5. release-plan.json must accurately model zero/one/many packages per repo,
   including private/non-published packages, package paths/names/versions,
   dependsOn, initial-vs-future scope, and GitHub releases. Do not invent
   packages. Model moved multi/plue packages for future aggregate releases while
   excluding them from initial publication until their PRs are merged.

6. LICENSE is one source path and cannot be assigned to multiple lanes. Keep
   exact path ownership, but add an explicit per-repo \`licenseSource: "LICENSE"\`
   / copy plan and require extraction/decoupling to copy the root MIT LICENSE
   into every new/target repo and set \`license: "MIT"\` in publishable package
   manifests. Update prompts and verification accordingly.

7. Pin federation-manifest-review.mdx and every other source investigation to
   \`{props.migrationRoot}/source-clone\`. State that the live checkout is
   forbidden evidence. Add the concurrent marketing exclusion. A review must
   judge the clean snapshot, the executable initial DAG, and the future
   aggregate plan separately.

8. Make the workflow refuse to pass the manifest phase when
   manifestReview.approvable is false; approval must not turn a rejected review
   into repository creation. Preserve exactly three human approvals overall,
   the exact agent pools (migrationEasy, migrationHard, migrationReview), ten
   public new repos, no force pushes, history preservation, and all existing
   safety gates.

9. Validate with real checks:
   - exact manifest path set equality against source-clone git ls-files
   - exact allowed destination set
   - acyclic initial ten-repo DAG/topological sort
   - release-plan referential consistency
   - every new repo has an explicit MIT copy plan
   - no marketing/** path goes to smithers-examples
   - no prompt tells an agent to inspect the live checkout
   - bun apps/cli/src/index.js graph .smithers/workflows/smithers-repo-federation.tsx
   - bun build --no-bundle .smithers/ui/smithers-repo-federation.tsx

REQUIRED OUTPUT:
{
  "summary": "what was repaired",
  "filesChanged": ["exact paths"],
  "pathCoverageExact": true,
  "dagAcyclic": true,
  "marketingOverlapRemoved": true,
  "reviewPinnedToCleanClone": true,
  "graphPassing": true,
  "uiBuildPassing": true,
  "remainingRisks": []
}
`}
    </Task>
  </Workflow>
));
