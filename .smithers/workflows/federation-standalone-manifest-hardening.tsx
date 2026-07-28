// smithers-source: local
// smithers-metadata-version: 1
// smithers-display-name: Federation Standalone Manifest Hardening
// smithers-description: Resolve final standalone-install, transitional-copy, and launch-verification gaps.
// smithers-tags: maintenance, federation, architecture
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";

const resultSchema = z.object({
  summary: z.string(),
  filesChanged: z.array(z.string()).default([]),
  standaloneWorkspaceRewritesComplete: z.boolean(),
  transitionalCopiesInventoried: z.boolean(),
  driftGuardsComplete: z.boolean(),
  reviewFindingsResolved: z.boolean(),
  priorInvariantsPreserved: z.boolean(),
});

const { Workflow, Task, smithers, outputs } = createSmithers({ result: resultSchema });

export default smithers(() => (
  <Workflow name="federation-standalone-manifest-hardening">
    <Task
      id="resolveFinalStandaloneFindings"
      output={outputs.result}
      agent={agents.migrationHard}
      timeoutMs={60 * 60_000}
      heartbeatTimeoutMs={20 * 60_000}
    >
      {`
Repair every actionable artifact finding from fresh Kimi/K3 architecture review
cd0536cd-8668-4b6e-9130-dfaa00a84e1b node
manifestReviewFinalApproved. That review returned approvable:false.

AUTHORITATIVE READ-ONLY SOURCE:
  /Users/williamcory/smithers-federation-migration-20260727/source-clone
ARTIFACTS YOU MAY EDIT:
  /Users/williamcory/smithers-federation-migration-20260727/artifacts/manifest.json
  /Users/williamcory/smithers-federation-migration-20260727/artifacts/dag.json
  /Users/williamcory/smithers-federation-migration-20260727/artifacts/release-plan.json

Never inspect the dirty live checkout as source evidence. Do not mutate the
source clone, GitHub, workflow code, or repository source. Make only artifact
plan/evidence/inventory changes; preserve canonical path ownership.

Resolve all findings, not just the two labeled blockers:

1. apps/signal/package.json: add an explicit split-time package-manifest rewrite
   from smithers-orchestrator workspace:* to ^0.31.0. The generated root
   manifest does not implicitly rewrite the nested app manifest. Specify
   ordering, lockfile regeneration, standalone install/typecheck/test/deploy
   validation, and future update policy.

2. apps/review/package.json: add an explicit INITIAL split-time semver rewrite
   for every workspace:* dependency so the GitHub-release repo installs before
   its deferred 0.32.0 npm publication. Use real versions justified by the
   initial publication order/external prerequisites (agents may use the
   newly-published initial version; retained core/facade and already-published
   ui-styleguide use their real published line). Keep the future source
   decoupling/republication plan distinct and specify its later dependency
   bumps. Regenerate lockfiles and validate standalone install/build/test.

3. .smithers/package.json in smithers-packs: explicitly define its fate. It is
   retained as the pack-local command/test manifest because source/tests read it;
   rewrite every retained workspace:* range to concrete semver, remove only a
   proven unused entry, and keep it consistent with the generated root manifest.
   Add a concrete created-at-split CI guard if needed that rejects workspace:*
   and checks dependency parity/intent. Specify root-vs-nested install behavior,
   lockfile regeneration, and standalone pack tests.

4. signalDailyCeoIntel: the plan already textually specifies
   scripts/check-ceo-intel-lib-drift.mjs and the three createdAtSplitFiles
   records already exist. Make this machine-recognizable rather than duplicating
   it: add planId, canonical source, driftGuard, checkCommand, ordering,
   updatePolicy, and validation fields to the two copy records and planId/check
   metadata to the guard record; strengthen the rewrite plan with explicit
   pre-release CI enforcement.

5. openclawPhasedRewire dual carriage: source proves exactly 8 canonical files,
   not 10. Keep their canonical manifest destination smithers-plugins, but
   update every record's notes to explicitly describe the temporary
   stays-in-smithers read-only materialized copy through Phase 4. Add exact
   createdAtSplitFiles entries for all 8 retained copies plus the exact
   created-at-split drift-guard script/check command; define pinned sync
   boundary, fail-loud CI, removal ordering, and verify the CLI never ships
   stale content. Do not create a second manifest ownership assignment.

6. signalConfigOwnership: correct stale evidence that calls
   .smithers/tests/daily-ceo-intel-pipeline.test.ts stays-in-smithers; the
   manifest and rewrite correctly assign it to smithers-packs.

7. apps/telegram-summary: make the smithers-integrations standalone root/workspace
   shape explicit and add the existing planned package.json
   @smithers-orchestrator/gateway-ui workspace:* -> ^0.31.0 split-time rewrite.
   Specify the generated/retained root manifest or workspace file(s), dependency
   installation, lockfile regeneration, and app test/typecheck validation.

8. Strengthen the existing symlink plan so the per-destination
   git ls-files -s plus dangling-link verification is a mandatory pre-push and
   pre-publish gate, not manual-adjacent prose.

9. Make awesome-smithers launch synchronization machine-verifiable: add an exact
   release-coordinator check that the docs-only PR lists all 10 repos and is
   merged (or otherwise in the explicitly gated state) before final release.
   Inventory any new owned check script exactly.

10. Add an explicit update/drift policy for the
    evals/lib/verify.test.ts embedded @smithers-orchestrator/ui adapter-import
    string fixtures: initial assertions pin the published 0.31.0 surface and a
    named check/update step runs when multi republishes/renames subpaths.

11. Ensure the openclaw dual-carriage guard and awesome-smithers check are
    required by the root coordinator/release dry run, not optional notes.

For any new created-at-split file, add one exact createdAtSplitFiles record with
repo/path, owning plan, purpose, ordering, owner/update policy, check command,
and validation. No wildcards or opaque directories.

Validation after editing:
- clean source clone, HEAD==origin/main==
  505717d175d5ef51b3b164aba5cbe969f805e2fe;
- manifest exactly 8,835 unique paths equal to git ls-files; canonical
  destinations unchanged except notes;
- every workspace:* in every initial extracted lane's package.json is either
  lane-local within an explicit generated workspace or has an exact split-time
  semver rewrite; no standalone install ambiguity remains;
- createdAtSplitFiles unique repo/path keys, exact paths, no wildcards;
- existing 90 support / 29 UI inventories and truthful preload count 31 remain;
- CEO-intel and openclaw copies have exact machine-recognizable drift policy;
- static aliases synchronized, 193 raw / 191 unique / unresolved [];
- dynamic audit 224 reads / 179 classified rows / unresolved [];
- initial DAG exactly 7 edges; future package DAG exactly 14 edges including
  engine -> review; semantic edge agreement and acyclicity preserved;
- gateway-react runtime/dev facts, prerequisite closure, docs/CI plans,
  artifact authority, root .repos, facade-last, marketing exclusion, MIT,
  versions, history, and all prior materialization policies remain valid.

REQUIRED OUTPUT:
{
  "summary": "all findings resolved",
  "filesChanged": ["exact artifact paths"],
  "standaloneWorkspaceRewritesComplete": true,
  "transitionalCopiesInventoried": true,
  "driftGuardsComplete": true,
  "reviewFindingsResolved": true,
  "priorInvariantsPreserved": true
}
`}
    </Task>
  </Workflow>
));
