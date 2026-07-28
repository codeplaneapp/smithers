// smithers-source: local
// smithers-metadata-version: 1
// smithers-display-name: Federation Architecture Fix
// smithers-description: Resolve clean-snapshot boundary, dependency, licensing, and release-coordinator blockers.
// smithers-tags: maintenance, federation, architecture
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";

const resultSchema = z.object({
  summary: z.string(),
  filesChanged: z.array(z.string()).default([]),
  exactPathCoverage: z.boolean(),
  packageOwnershipConsistent: z.boolean(),
  initialDagAcyclic: z.boolean(),
  initialPlanExecutable: z.boolean(),
  futurePlanExecutable: z.boolean(),
  licensePlansComplete: z.boolean(),
  cleanCloneOnly: z.boolean(),
  remainingRisks: z.array(z.string()).default([]),
});

const { Workflow, Task, smithers, outputs } = createSmithers({ result: resultSchema });

export default smithers(() => (
  <Workflow name="federation-architecture-fix">
    <Task
      id="fix"
      output={outputs.result}
      agent={agents.migrationHard}
      timeoutMs={60 * 60_000}
      heartbeatTimeoutMs={20 * 60_000}
    >
      {`
Repair every real architecture blocker in the Smithers federation artifacts.
This is implementation work, not a review.

AUTHORITATIVE READ-ONLY SOURCE:
  /Users/williamcory/smithers-federation-migration-20260727/source-clone
ARTIFACTS TO EDIT:
  /Users/williamcory/smithers-federation-migration-20260727/artifacts/manifest.json
  /Users/williamcory/smithers-federation-migration-20260727/artifacts/dag.json
  /Users/williamcory/smithers-federation-migration-20260727/artifacts/release-plan.json

Never inspect or use /Users/williamcory/smithers as source evidence. It is a
dirty concurrent checkout. Do not edit the clean clone, workflow code, prompts,
GitHub, or any repository. Validate against source-clone HEAD/origin/main only.

Preserve:
- exactly 8,835 unique manifest paths equal to source-clone git ls-files;
- every marketing/** path stays-in-smithers for the concurrent marketing agent;
- the exact approved 10 new public repos plus multi/plue future PR lanes and
  awesome-smithers docs-only;
- initial/future/never scope separation, facade final/meta, no force pushes;
- exact MIT repo-level license plans and OpenClaw/Smithers UI rewires already
  modeled.

Fix all real findings:

1. All 50 packages/pi-plugin/** paths belong to smithers-plugins, consistent
   with the @smithers-orchestrator/pi-plugin package record. Update manifest
   ownership/notes and destination counts without changing the path set.

2. Reconcile every release-plan package path with manifest ownership. Prove
   each package path exists in the clean clone and every path below it belongs
   to its repo. packages/ui-core DOES exist in the clean clone; keep it future
   multi. Ignore live-checkout-only false findings.

3. Model actual direct dependencies of smithers-examples. Its generated root
   manifest must include semver dependencies/devDependencies for every directly
   imported @smithers-orchestrator package, not only the facade. Add only real
   initial-DAG edges to new repos (for example agents -> examples if required);
   concrete already-published Smithers packages remain external semver
   prerequisites.

4. apps/cli stays in Smithers but depends on @smithers-orchestrator/review,
   whose npm publication is future after multi/ui-styleguide. Add a precise
   future aggregate rewrite: keep source intact until review publishes, then
   pin CLI to review semver before source removal. Order multi -> review ->
   Smithers CLI/kernel update -> facade final/meta. The initial new-repo release
   must remain executable.

5. Audit every stays-in-smithers package/script/test that consumes moved code:
   - core package workspace dependencies on agents/observability;
   - e2e imports of sandbox/observability;
   - .smithers/tests that exercise moved pack workflows;
   - scripts/generate-workflow-pack.ts and CLI built-in/init pack generation;
   - check:local-smithers plugin copies.
   Decide ownership or model a concrete semver/generated-artifact/local-fixture
   rewire. The root release coordinator must publish initial extension packages,
   then rewire retained packages to semver, then publish retained CLI/core, and
   publish the facade last. No retained repo-relative reads of moved sources.
   Prefer moving pack-specific tests to smithers-packs. If the CLI needs a
   shipped pack, model a real versioned package/artifact from smithers-packs
   rather than pretending a zero-package repo can satisfy the source read.

6. Add per-published-package license actions, not merely repo-root LICENSE
   copies: set package.json license:"MIT" and ensure each npm tarball contains
   LICENSE (copy/include as appropriate). Keep repo root license plans too.

7. @smithers/openclaw-plugin imports openclaw/plugin-sdk/plugin-entry; model the
   correct declared peer/runtime dependency and verification. Keep apps/signal
   explicitly private/non-npm. Preserve the materialize/regenerate plan for 257
   cross-repo symlinks.

8. Ensure future aggregate package/repo ordering includes every new package
   created by these fixes, package-level topological order for multi-package
   repos, retained Smithers semver rewires, CLI, review, and facade last.
   Initial packages must depend only on initial packages or allowed concrete
   core prerequisites, never future packages or the facade.

9. Keep canonical docs in Smithers but require link rewrites to new GitHub URLs
   and docs:llms regeneration. awesome-smithers remains docs-only with its PR.

Run hard validation:
- exact clean-clone path equality and uniqueness;
- package-path ownership consistency;
- allowed destination set and marketing exclusion;
- acyclic initial repo and package DAG;
- initial dependency closure;
- executable future aggregate order with facade last;
- every repo and published package has a complete MIT plan;
- every retained cross-repo consumer has an explicit rewrite and release order.

REQUIRED OUTPUT:
{
  "summary": "what was repaired",
  "filesChanged": ["exact paths"],
  "exactPathCoverage": true,
  "packageOwnershipConsistent": true,
  "initialDagAcyclic": true,
  "initialPlanExecutable": true,
  "futurePlanExecutable": true,
  "licensePlansComplete": true,
  "cleanCloneOnly": true,
  "remainingRisks": []
}
`}
    </Task>
  </Workflow>
));
