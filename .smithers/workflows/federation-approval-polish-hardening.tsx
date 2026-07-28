// smithers-source: local
// smithers-metadata-version: 1
// smithers-display-name: Federation Approval Polish Hardening
// smithers-description: Encode the actionable non-blocking findings from the final Kimi architecture review.
// smithers-tags: maintenance, federation, architecture
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";

const resultSchema = z.object({
  summary: z.string(),
  filesChanged: z.array(z.string()).default([]),
  findingsResolved: z.array(z.string()).default([]),
  exactPathCoverage: z.boolean(),
  staticAuditPreserved: z.boolean(),
  dynamicAuditPreserved: z.boolean(),
  dagAcyclic: z.boolean(),
  priorInvariantsPreserved: z.boolean(),
});

const { Workflow, Task, smithers, outputs } = createSmithers({ result: resultSchema });

export default smithers(() => (
  <Workflow name="federation-approval-polish-hardening">
    <Task
      id="hardenApprovalPolishFindings"
      output={outputs.result}
      agent={agents.migrationHard}
      timeoutMs={60 * 60_000}
      heartbeatTimeoutMs={20 * 60_000}
    >
      {`
Implement only the actionable non-blocking findings from the fresh final Kimi
architecture review, run 0bea7eb5-6cc5-4b1c-ad89-4eaccbf4a3a1 node
manifestReviewApproved. This is artifact-only implementation work.

AUTHORITATIVE READ-ONLY SOURCE:
  /Users/williamcory/smithers-federation-migration-20260727/source-clone
ARTIFACTS YOU MAY EDIT:
  /Users/williamcory/smithers-federation-migration-20260727/artifacts/manifest.json
  /Users/williamcory/smithers-federation-migration-20260727/artifacts/dag.json
  /Users/williamcory/smithers-federation-migration-20260727/artifacts/release-plan.json

Never inspect the dirty live checkout as source evidence. Do not mutate the
source clone, GitHub, workflow code, or repository source. Preserve every
already-established ownership decision and exact path coverage.

The architecture review returned approvable:true and verified all core
invariants. Encode these findings so execution is unambiguous:

1. packages/cloudflare imports @smithers-orchestrator/db only from
   packages/cloudflare/tests/cloudflare-sqlite.test.js. Remove db from the
   package record's runtime dependsOn and record it as devDependsOn. Do not
   change the initial repo DAG because db is an already-published external
   prerequisite in stays-in-smithers.

2. Add an explicit futureAggregate.packageEdges entry from
   @smithers-orchestrator/engine to @smithers-orchestrator/review. Its reason
   must state that engine@0.32.0 first exports createSmithers and
   openSmithersBackend per the review rewritePlan. Keep the existing
   ui-styleguide and agents edges and preserve the initial DAG unchanged.

3. apps/signal imports smithers-orchestrator/ui in production runner/site code.
   Move smithers-orchestrator:^0.31.0 from the smithers-signal generated root
   manifest devDependencies to dependencies, and make its notes explicitly
   runtime. This remains an external prerequisite, not an initial DAG edge.

4. Extend docsPlan.marketingCoordination.retainedAssignments with explicit
   per-app ownership notes for apps/automate-site, apps/init-site,
   apps/self-healing-site, and apps/demoday-site. They move to
   smithers-examples as technical/example sites. marketing/** remains wholly
   excluded and untouched for the concurrent marketing migration. If the plan
   needs a confirmation checkpoint, encode it without weakening the exact lane
   ownership already approved.

5. Make executable README/CI plans explicit:
   - smithers-review README states the initial GitHub release is intentionally
     not standalone npm-publishable until multi publishes ui-styleguide and
     the engine/facade decoupling lands. Its initial CI must run the subset that
     is valid before those future prerequisites, while aggregate CI verifies
     the deferred full suite.
   - standalone smithers-examples CI must skip or parameterize the ferric-site
     FERRIC_SOURCE_ROOT aggregate-only coupling to smithers-packs.
   - standalone smithers-evals CI must skip or parameterize kanban-bench
     PACK_SOURCE_ROOT and roadmapbench harnessPath aggregate-only couplings to
     smithers-packs.
   Add narrowly named createdAtSplitFiles and/or crossRepoRewrites plans for
   README and CI files if not already present. Every created file must specify
   repo, exact path, purpose, update policy, ordering, and validation. Do not
   claim a generated file exists in the source snapshot.

6. The stale prose inventory summary from old prompts must never be consumed
   downstream. Record the three JSON artifacts as the sole machine authority
   and current exact counts (8,835 paths; 7 initial DAG edges; 191 unique/193
   raw static; 179 classified dynamic rows from 224 reads scanned). Do not
   change audited arrays merely to satisfy these prose counts.

Validation after editing:
- source HEAD == origin/main ==
  505717d175d5ef51b3b164aba5cbe969f805e2fe;
- manifest has exactly 8,835 unique paths equal to git ls-files;
- release-plan staticEdgeAudit/staticImportAudit remain synchronized with 191
  classified unique rows and unresolved [];
- dynamicReadAudit remains fully classified with 179 rows and unresolved [];
- dag.json remains acyclic with the same 7 initial edges and valid order;
- future aggregate ordering is acyclic and contains engine -> review;
- root .repos aggregation, facade-last, package closure, marketing exclusion,
  licenses, versions, history, symlinks, and all drift policies remain valid.

REQUIRED OUTPUT:
{
  "summary": "what was hardened",
  "filesChanged": ["exact artifact paths"],
  "findingsResolved": ["cloudflare-dev-dep", "engine-review-edge",
    "signal-runtime-dep", "marketing-site-coordination",
    "standalone-readme-ci", "artifact-authority"],
  "exactPathCoverage": true,
  "staticAuditPreserved": true,
  "dynamicAuditPreserved": true,
  "dagAcyclic": true,
  "priorInvariantsPreserved": true
}
`}
    </Task>
  </Workflow>
));
