// smithers-source: local
// smithers-metadata-version: 1
// smithers-display-name: Federation Artifact Edge Sync
// smithers-description: Synchronize future package dependency facts across reviewed federation artifacts.
// smithers-tags: maintenance, federation, architecture
/** @jsxImportSource smthrs */
import { createSmithers } from "smthrs";
import { z } from "zod/v4";
import { agents } from "../agents";

const resultSchema = z.object({
  summary: z.string(),
  filesChanged: z.array(z.string()).default([]),
  releasePlanDagSynchronized: z.boolean(),
  engineReviewEdgePresent: z.boolean(),
  gatewayReactRuntimeDependenciesCorrect: z.boolean(),
  priorInvariantsPreserved: z.boolean(),
});

const { Workflow, Task, smithers, outputs } = createSmithers({ result: resultSchema });

export default smithers(() => (
  <Workflow name="federation-artifact-edge-sync">
    <Task
      id="synchronizeFutureDependencyFacts"
      output={outputs.result}
      agent={agents.migrationHard}
      timeoutMs={60 * 60_000}
      heartbeatTimeoutMs={20 * 60_000}
    >
      {`
Repair one narrow artifact synchronization regression.

AUTHORITATIVE READ-ONLY SOURCE:
  /Users/williamcory/smithers-federation-migration-20260727/source-clone
ARTIFACTS YOU MAY EDIT:
  /Users/williamcory/smithers-federation-migration-20260727/artifacts/dag.json
  /Users/williamcory/smithers-federation-migration-20260727/artifacts/release-plan.json

Never inspect the dirty live checkout as source evidence. Do not mutate the
source clone, manifest.json, GitHub, workflow code, or repository source.

The release plan and DAG currently disagree in futureAggregate:
- dag.json has the required @smthrs/engine ->
  @smthrs/review package edge; release-plan.json omits it.
- release-plan.json correctly records @smthrs/gateway-react
  runtime dependsOn/postDecoupleDependsOn as gateway-client only and
  devDependsOn as db/server. dag.json still incorrectly puts db/server in its
  runtime dependsOn/postDecoupleDependsOn.

Synchronize both artifacts to the already-reviewed intended facts:
1. Both futureAggregate.packageEdges arrays contain exactly one identical
   engine -> review edge, using the existing dag.json reason.
2. Both futureAggregate gateway-react moved-package records have runtime
   dependsOn/postDecoupleDependsOn = gateway-client only and devDependsOn =
   db/server.
3. Preserve artifact-specific descriptive fields such as licenseActions; exact
   whole-object equality is not required. Dependency-bearing moved-package
   fields and package-edge sets must agree semantically.
4. Do not alter initial scope, publication order, unrelated edges, or the 55
   createdAtSplitFiles records.

Validate after editing:
- source clone remains clean at
  505717d175d5ef51b3b164aba5cbe969f805e2fe;
- release plan and DAG each have 14 future package edges with exactly one
  engine -> review edge and identical semantic edge sets;
- gateway-react dependency-bearing fields agree and match rule 2;
- initial DAG retains exactly 7 edges and is acyclic/topological;
- future aggregate is acyclic/topological;
- release plan remains valid JSON with 55 unique exact createdAtSplitFiles;
- static aliases remain synchronized, 193 raw / 191 unique / unresolved [];
- dynamic audit remains 224 reads / 179 classified rows / unresolved [];
- manifest remains untouched and all previous ownership, prerequisite, docs,
  history, license, version, marketing, symlink, root .repos, facade-last, and
  materialization-inventory invariants remain unchanged.

REQUIRED OUTPUT:
{
  "summary": "what was synchronized",
  "filesChanged": ["exact artifact paths"],
  "releasePlanDagSynchronized": true,
  "engineReviewEdgePresent": true,
  "gatewayReactRuntimeDependenciesCorrect": true,
  "priorInvariantsPreserved": true
}
`}
    </Task>
  </Workflow>
));
