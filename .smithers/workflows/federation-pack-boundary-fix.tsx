// smithers-source: local
// smithers-metadata-version: 1
// smithers-display-name: Federation Pack Boundary Fix
// smithers-description: Repair pack/retained-test ownership and standalone dependency gaps in federation artifacts.
// smithers-tags: maintenance, federation, architecture
/** @jsxImportSource smthrs */
import { createSmithers } from "smthrs";
import { z } from "zod/v4";
import { agents } from "../agents";

const resultSchema = z.object({
  summary: z.string(),
  filesChanged: z.array(z.string()).default([]),
  exactPathCoverage: z.boolean(),
  packBoundaryComplete: z.boolean(),
  retainedTestsStandalone: z.boolean(),
  packTestsStandalone: z.boolean(),
  packageFactsCorrected: z.boolean(),
  initialDagAcyclic: z.boolean(),
  remainingRisks: z.array(z.string()).default([]),
});

const { Workflow, Task, smithers, outputs } = createSmithers({ result: resultSchema });

export default smithers(() => (
  <Workflow name="federation-pack-boundary-fix">
    <Task
      id="fixPackBoundary"
      output={outputs.result}
      agent={agents.migrationHard}
      timeoutMs={60 * 60_000}
      heartbeatTimeoutMs={20 * 60_000}
    >
      {`
Repair the newly discovered pack/retained-test boundary defects in the Smithers
federation artifacts. This is implementation work, not a review.

AUTHORITATIVE READ-ONLY SOURCE:
  /Users/williamcory/smithers-federation-migration-20260727/source-clone
ARTIFACTS YOU MAY EDIT:
  /Users/williamcory/smithers-federation-migration-20260727/artifacts/manifest.json
  /Users/williamcory/smithers-federation-migration-20260727/artifacts/dag.json
  /Users/williamcory/smithers-federation-migration-20260727/artifacts/release-plan.json

Never use the dirty live checkout as source evidence. Do not edit source-clone,
workflow code, GitHub, or any repository. Preserve all established boundaries,
versions, license plans, initial/future scope, history policy, and every
marketing/** assignment.

The latest fresh Kimi review verified exact 8,835-path coverage, the acyclic
6-edge initial DAG, licenses, versions, and history lanes, but found these real
defects. Resolve every one with evidence from source-clone:

1. .smithers/preload.ts stays-in-smithers while smithers-packs owns
   .smithers/bunfig.toml, .smithers/package.json, and moved tests that require
   ./preload.ts. Keep one canonical path assignment, but add an explicit
   duplication/materialization rewrite so BOTH standalone test surfaces get a
   local preload. Reconcile bunfig and scripts accordingly.

2. Audit and resolve every retained test that reads moved pack code, including:
   - .smithers/tests/seeded-pack-workflows.test.tsx and all related seeded-* tests
     that dynamically load moved workflows;
   - .smithers/tests/review-ui-composition.test.ts reading ../ui/review.tsx;
   - .smithers/tests/local-workflows-b-utilities.test.tsx resolving
     ../workflows/restore-claude-implement.tsx;
   - .smithers/tests/implement-testing-framework-e2e-workflow.test.ts reading
     ../workflows/implement-testing-framework-e2e.tsx.
   Decide from ownership: move pack-specific tests to smithers-packs, split a
   mixed test, or vendor a precise local fixture. No repo-relative cross-lane
   read may remain, and every created-at-split file must be explicit.

3. Reconcile .smithers/package.json and its test/release scripts for the actual
   two-lane test ownership. The packs repo must not enumerate tests retained in
   Smithers or run "cd .." release commands against the old monorepo. Retained
   tests must still have an explicit runnable command/manifest or be moved with
   their owned code. Model concrete rewrites and standalone validation.

4. .smithers/tests/flagship-ui-render.test.tsx imports
   @smthrs/gateway-react and gateway-ui. Add both already-published
   ^0.31.0 packages to smithers-packs generatedRootManifest devDependencies and
   correct its false notes.

5. Correct the packages/agent-eliza rewrite facts: there are three type-only
   facade import sites (src/conventions/index.d.ts,
   src/conventions/types.ts, tests/conventions.test.ts), not one. The rewrite
   and post-check must enumerate all three.

6. Add concrete rewrites for pack workflow prompt strings that tell agents to
   edit moved monorepo paths:
   .smithers/workflows/test-fortress.tsx,
   postgres-tanstack-sync.tsx, and tanstack-db-sync-engine.tsx. Use new GitHub
   repo/aggregate-local paths appropriate to the owning lane.

7. examples/init-pack/make-workflow-tutorial.tsx dynamically imports
   @smthrs/observability/_traceRedaction with a fallback. Declare
   observability ^0.32.0 as an optional dependency and add the corresponding real
   initial edge smithers-observability -> smithers-packs if initial publication
   installs it; alternatively make the degradation explicit and verifiable.
   Choose one executable design and keep dag.json/release-plan synchronized.

8. Make phase ordering eliminate the OpenClaw behavior-regression window:
   retain the CLI's local plugin source until @smithers/openclaw-plugin@0.1.0 is
   published, then atomically add/pin the package dependency, rewire
   registerOpenClawPlugin.js, test installation, and only then remove the local
   source in the removal PR. Do not create a publication cycle with pi-plugin;
   its CLI prerequisite remains the already-published ^0.31.0 line.

9. Add a drift guard for the retained read-only apps/review copy until
   @smthrs/review@0.32.0 publishes and the copy is removed.

10. Make the createSmithers move/export into
    @smthrs/engine an explicit prerequisite/action for review
    facade decoupling; engine does not export it today.

11. Verify whether gateway-react's db/server imports are type-only and correct
    runtime/dev dependency claims accordingly.

After edits prove:
- manifest paths exactly equal clean-clone git ls-files, unique count 8,835;
- package/repo ownership is consistent;
- both pack and retained test surfaces have standalone scripts, preload, and
  dependencies with no parent-repo reads;
- crossRepoRewrites cover all listed reads and factual claims are correct;
- dag top-level and scopes.initial remain synchronized and acyclic;
- any new initial dependency is represented by both a real package dependency
  and matching repo edge/order;
- every previous license/version/history/marketing invariant still holds.

REQUIRED OUTPUT:
{
  "summary": "what was repaired",
  "filesChanged": ["exact artifact paths"],
  "exactPathCoverage": true,
  "packBoundaryComplete": true,
  "retainedTestsStandalone": true,
  "packTestsStandalone": true,
  "packageFactsCorrected": true,
  "initialDagAcyclic": true,
  "remainingRisks": []
}
`}
    </Task>
  </Workflow>
));
