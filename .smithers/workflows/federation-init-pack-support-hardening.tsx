// smithers-source: local
// smithers-metadata-version: 1
// smithers-display-name: Federation Init Pack Support Hardening
// smithers-description: Complete exact split-time inventory for archived init-pack support and correct preload evidence.
// smithers-tags: maintenance, federation, architecture
/** @jsxImportSource smthrs */
import { createSmithers } from "smthrs";
import { z } from "zod/v4";
import { agents } from "../agents";

const resultSchema = z.object({
  summary: z.string(),
  filesChanged: z.array(z.string()).default([]),
  supportCopiesInventoried: z.number(),
  uiCopiesInventoried: z.number(),
  preloadImporterCount: z.number(),
  allMaterializationsExact: z.boolean(),
  priorInvariantsPreserved: z.boolean(),
});

const { Workflow, Task, smithers, outputs } = createSmithers({ result: resultSchema });

export default smithers(() => (
  <Workflow name="federation-init-pack-support-hardening">
    <Task
      id="inventoryInitPackSupportExactly"
      output={outputs.result}
      agent={agents.migrationHard}
      timeoutMs={60 * 60_000}
      heartbeatTimeoutMs={20 * 60_000}
    >
      {`
Repair only the two residual evidence defects from fresh independent Luna xhigh
audit 0d51d020-1816-4a71-a216-432fb6b8c9c0 node auditStaticImports.

AUTHORITATIVE READ-ONLY SOURCE:
  /Users/williamcory/smithers-federation-migration-20260727/source-clone
ARTIFACT YOU MAY EDIT:
  /Users/williamcory/smithers-federation-migration-20260727/artifacts/release-plan.json
READ-ONLY COMPANION ARTIFACTS:
  /Users/williamcory/smithers-federation-migration-20260727/artifacts/manifest.json
  /Users/williamcory/smithers-federation-migration-20260727/artifacts/dag.json

Never inspect the dirty live checkout as source evidence. Do not mutate the
source clone, manifest, DAG, GitHub, workflow code, or repository source.

Luna verified every other architecture invariant and rejected approval only
because:
1. initPackExampleSupport claims 90 distinct pack-local support-file
   materializations but createdAtSplitFiles does not inventory the 90 exact
   destinations or their concrete support-copy drift/update policy.
2. preloadMaterialization says 41 pack-lane test files directly import
   "../preload.ts"; the clean source and static audit prove exactly 31.

Required repair:
- Recompute the exact 90 distinct imported support source files from the 30
  manifest-owned examples/init-pack workflows. For each, choose and document
  the exact deterministic pack-local destination implied by the rewrite plan,
  then add one exact smithers-packs createdAtSplitFiles record. Each record must
  name plan id initPackExampleSupport, canonical smithers-examples source,
  destination/rewrite convention, creation ordering, byte-identical update
  policy, concrete CI drift guard/check command, and validation. Do not use a
  wildcard or directory aggregate record.
- Add and inventory an exact created-at-split support-copy CI drift-guard script
  if the plan lacks one; strengthen initPackExampleSupport rewrites/evidence so
  all 90 copies, import rewrites, canonical source ownership, sync boundary,
  refresh-only policy, and lane-internal validation are executable and
  unambiguous.
- The current examples/init-pack/ui/ directory aggregate represents 29 planned
  UI file copies. Replace it with 29 exact file records derived from the 30
  workflows' distinct <UI entry> references. Preserve the existing UI drift
  guard and policy. This prevents a future audit from accepting an opaque
  directory as an exact inventory.
- Correct every preloadMaterialization evidence/action occurrence that says 41
  direct test importers to the verified exact count 31. Do not change the
  existing preload copy or its drift guard.
- Do not invent source paths. Do not add any materialized target to
  manifest.json. Manifest ownership remains unique; createdAtSplitFiles is the
  explicit target-repo creation inventory.

Validation after editing:
- source clone clean at
  505717d175d5ef51b3b164aba5cbe969f805e2fe;
- manifest remains exactly 8,835 unique paths equal to git ls-files;
- exactly 90 distinct support-source files and 90 exact corresponding
  smithers-packs destination records, with no duplicate destination;
- exactly 29 distinct referenced UI files and 29 exact corresponding
  smithers-packs destination records; no examples/init-pack/ui/ directory
  aggregate remains;
- one concrete support drift guard and the existing UI drift guard are
  inventoried, with executable check commands/policies;
- preloadMaterialization consistently and truthfully says 31 direct test
  importers;
- createdAtSplitFiles contains no duplicate repo/path keys and no wildcard or
  opaque directory entries for these plans;
- static aliases remain synchronized, 193 raw / 191 unique / unresolved [];
- dynamic audit remains 224 reads / 179 classified rows / unresolved [];
- initial DAG remains 7 edges; future DAG remains 14 package edges including
  engine -> review; both remain acyclic/topological;
- gateway-react runtime/dev facts and package-edge semantic agreement remain
  unchanged;
- prerequisite closure, docs/CI plans, artifact authority, root .repos,
  facade-last, marketing exclusion, licenses, versions, history, symlinks, and
  all other materialization policies remain unchanged.

REQUIRED OUTPUT:
{
  "summary": "what was inventoried and corrected",
  "filesChanged": ["exact artifact path"],
  "supportCopiesInventoried": 90,
  "uiCopiesInventoried": 29,
  "preloadImporterCount": 31,
  "allMaterializationsExact": true,
  "priorInvariantsPreserved": true
}
`}
    </Task>
  </Workflow>
));
