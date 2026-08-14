// smithers-source: local
// smithers-metadata-version: 1
// smithers-display-name: Federation Final Audit Hardening
// smithers-description: Repair the exact residual boundaries found by the final independent Luna audit.
// smithers-tags: maintenance, federation, architecture
/** @jsxImportSource smthrs */
import { createSmithers } from "smthrs";
import { z } from "zod/v4";
import { agents } from "../agents";

const resultSchema = z.object({
  summary: z.string(),
  filesChanged: z.array(z.string()).default([]),
  exactPathCoverage: z.boolean(),
  resolvedStaticEdges: z.number().int(),
  classifiedStaticEdges: z.number().int(),
  unresolvedStaticEdges: z.array(z.string()).default([]),
  resolvedDynamicReads: z.number().int(),
  classifiedDynamicReads: z.number().int(),
  unresolvedDynamicReads: z.array(z.string()).default([]),
  dagAcyclic: z.boolean(),
  priorInvariantsPreserved: z.boolean(),
});

const { Workflow, Task, smithers, outputs } = createSmithers({ result: resultSchema });

export default smithers(() => (
  <Workflow name="federation-final-audit-hardening">
    <Task
      id="hardenFinalAuditFindings"
      output={outputs.result}
      agent={agents.migrationHard}
      timeoutMs={60 * 60_000}
      heartbeatTimeoutMs={20 * 60_000}
    >
      {`
Repair only the residual boundary-audit discrepancies from the final independent
Luna xhigh audit. This is artifact implementation work.

AUTHORITATIVE READ-ONLY SOURCE:
  /Users/williamcory/smithers-federation-migration-20260727/source-clone
ARTIFACTS YOU MAY EDIT:
  /Users/williamcory/smithers-federation-migration-20260727/artifacts/manifest.json
  /Users/williamcory/smithers-federation-migration-20260727/artifacts/dag.json
  /Users/williamcory/smithers-federation-migration-20260727/artifacts/release-plan.json

Never inspect the dirty live checkout as source evidence. Do not mutate the
source clone, GitHub, workflow code, or repository source. Preserve every
already-established ownership decision and exact path coverage.

The authoritative audit is run cebf8972-23dc-4dda-a8b1-34294c979c6f. It
verified the clean source commit, 8,835 exact paths, package ownership,
materializations, DAG/order, dependency closure, marketing exclusion, MIT
coverage, versions, history policy, and facade-last. It rejected approval only
for these concrete discrepancies:

STATIC:
1. apps/cli/tests/examples-init-pack.test.js:5 ->
   packages/smithers/tests/e2e-helpers.js
2. apps/cli/tests/seeded-pack-fresh.test.js:5 ->
   apps/cli/src/seeded-workflow-pack.generated.js
3. apps/cli/tests/workflow-pack-component-drift.test.js:10 ->
   packages/smithers/tests/e2e-helpers.js
4. apps/cli/tests/workflow-pack-component-drift.test.js:11 ->
   apps/cli/src/workflow-pack.js
5. apps/signal/site/src/types.ts:3 ->
   .smithers/lib/daily-ceo-intel/render.ts; its existing audit row has stale
   line 1 and must record actual line 3.

DYNAMIC:
6. .smithers/gateway.ts:30-53 -> .smithers/workflows/ via the
   import.meta.url-rooted resolve/readdirSync/readFileSync/dynamic-import loop.
7. apps/cli/src/agent-wiring/registerOpenClawPlugin.js:6-49 ->
   apps/cli/src/openclaw-plugin/ via import.meta.url-rooted
   join/existsSync/cpSync.

SCHEMA/COUNT:
8. release-plan.json documents the scanner only as staticEdgeAudit although the
   review contract calls the machine-readable classification staticImportAudit.
   Add a non-divergent canonical field or explicit synchronized alias so both
   names resolve to the exact same 191 unique/193 raw classified scan.
9. Rebuild the static scan deterministically: Luna found 191 unique/193 raw,
   while the artifact currently records 187 unique/189 raw.

For items 1-4, inspect the existing pack/CLI ownership and rewrite plans. Make
the exact pairs explicit under the already-correct executable plan where
possible; do not hide them under directory prose. For items 6-7, add exact
dynamic rows and point them at executable existing plans or add narrowly named
plans with concrete post-split locations, update/drift policy, and ordering.
Gateway workflow discovery must still find installed/aggregate workflows.
OpenClaw plugin installation must still copy the shipped plugin bundle.

Run the same deterministic scanners after editing. Every audit row must name
the exact source, target, real line, source lane, target lane, classification,
planId, and concrete evidence. Every referenced planId must exist in
crossRepoRewrites.plans or a named futureAggregate object. Do not merely set
unresolved to [].

Hard validation:
- clean source HEAD == origin/main == 505717d175d5ef51b3b164aba5cbe969f805e2fe;
- exactly 8,835 unique manifest paths equal git ls-files;
- all 191 resolved static pairs classified, unresolved [];
- every resolved dynamic cross-lane read classified, unresolved [];
- package ownership, created-file drift policies, root .repos aggregation,
  topological publish/facade-last, DAG/scoped ordering, closure, marketing,
  licenses, versions, history, symlinks, and OpenClaw phasing remain valid.

REQUIRED OUTPUT:
{
  "summary": "what was repaired",
  "filesChanged": ["exact artifact paths"],
  "exactPathCoverage": true,
  "resolvedStaticEdges": 191,
  "classifiedStaticEdges": 191,
  "unresolvedStaticEdges": [],
  "resolvedDynamicReads": 0,
  "classifiedDynamicReads": 0,
  "unresolvedDynamicReads": [],
  "dagAcyclic": true,
  "priorInvariantsPreserved": true
}
`}
    </Task>
  </Workflow>
));
