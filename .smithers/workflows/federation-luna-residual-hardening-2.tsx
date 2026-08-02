// smithers-source: local
// smithers-metadata-version: 1
// smithers-display-name: Federation Luna Residual Hardening 2
// smithers-description: Repair the exact residual consistency defects found by the fresh post-polish Luna audit.
// smithers-tags: maintenance, federation, architecture
/** @jsxImportSource smthrs */
import { createSmithers } from "smthrs";
import { z } from "zod/v4";
import { agents } from "../agents";

const resultSchema = z.object({
  summary: z.string(),
  filesChanged: z.array(z.string()).default([]),
  exactPathCoverage: z.boolean(),
  staticAuditLineEvidenceCurrent: z.boolean(),
  dynamicAuditLineEvidenceCurrent: z.boolean(),
  gatewayReactDependencyFactsConsistent: z.boolean(),
  initialExternalPrerequisitesComplete: z.boolean(),
  dagAcyclic: z.boolean(),
  priorInvariantsPreserved: z.boolean(),
});

const { Workflow, Task, smithers, outputs } = createSmithers({ result: resultSchema });

export default smithers(() => (
  <Workflow name="federation-luna-residual-hardening-2">
    <Task
      id="hardenFreshLunaResiduals"
      output={outputs.result}
      agent={agents.migrationHard}
      timeoutMs={60 * 60_000}
      heartbeatTimeoutMs={20 * 60_000}
    >
      {`
Repair only the exact residual consistency defects found by the fresh
independent Luna xhigh audit, run
5d6e625d-8348-40f4-958d-6a410e83a4f0 node auditStaticImports.

AUTHORITATIVE READ-ONLY SOURCE:
  /Users/williamcory/smithers-federation-migration-20260727/source-clone
ARTIFACTS YOU MAY EDIT:
  /Users/williamcory/smithers-federation-migration-20260727/artifacts/manifest.json
  /Users/williamcory/smithers-federation-migration-20260727/artifacts/dag.json
  /Users/williamcory/smithers-federation-migration-20260727/artifacts/release-plan.json

Never inspect the dirty live checkout as source evidence. Do not mutate the
source clone, GitHub, workflow code, or repository source. Preserve exact
ownership, path coverage, and all already-valid architecture decisions.

The audit verified clean source commit
505717d175d5ef51b3b164aba5cbe969f805e2fe, exact 8,835-path coverage, 5,586
source files scanned, 191/191 unique static pairs, all dynamic reads
classified, empty unresolved arrays, marketing exclusion, package ownership,
MIT policy, versions, history, DAG topology/order, and facade-last. It returned
approvable:false only for:

1. Correct the two static audit line values for
   packages/gateway-react/tests/smithers-electric-provider-parity.test.ts.
   The artifact records lines 12 and 17; the exact imports in the authoritative
   source are lines 16 and 21. Update both synchronized aliases,
   staticEdgeAudit and staticImportAudit, without changing pair identity,
   classification, planId, raw/unique counts, or any other row.

2. Recompute exact current line evidence for every dynamicReadAudit row whose
   source is one of:
   - .smithers/tests/local-workflows-d-campaigns.test.tsx
   - .smithers/workflows/smoketest.tsx
   - apps/cli/src/index.js
   - apps/cli/src/installCuratedSkill.js
   - apps/cli/src/localUiServer.js
   - scripts/generate-llms.ts
   - scripts/optimize-llms-full.ts
   - apps/cli/tests/smithers-skill-contract.test.js
   - packages/server/src/gatewayUi/bundle.js
   - scripts/check-no-direct-db-access.mjs
   - scripts/check-smithers-test-script.mjs
   - apps/ferric-site/scripts/build-site.mjs
   Inspect every matching row and the exact source expression. Update only
   stale line/range evidence. Preserve source/target identity, classification,
   planId, row count 179, readsScanned 224, and unresolved [].

3. Make the @smthrs/gateway-react package facts consistent
   between release-plan.json packages and futureAggregate.movedPackages. The
   source package.json keeps @smthrs/db and
   @smthrs/server as devDependencies, not runtime dependencies.
   Runtime dependsOn must contain only @smthrs/gateway-client;
   devDependsOn must contain db and server in every machine-readable package
   record. Preserve future package ordering.

4. Complete dag.json scopes.initial.externalPrerequisites to include every
   published external package referenced by the initial generated root
   manifests in release-plan.json. Luna identified these omissions:
   - smthrs
   - @smthrs/accounts
   - @smthrs/review
   - @smthrs/testing
   - @smthrs/usage
   - @smthrs/vcs
   - @smthrs/gateway-react
   - @smthrs/gateway-ui
   Inspect schema and existing externalPrerequisites records; add or synchronize
   exact semver/source/scope metadata rather than bare strings. These are
   external prerequisites, never initial repo-DAG edges. Ensure dag.json and
   release-plan.json external prerequisite authority agree and do not invent an
   npm publication if an item is consumed through the published facade/subpath.

Validation after editing:
- source clone clean; HEAD == origin/main == pinned commit;
- manifest exactly equals git ls-files with 8,835 unique paths;
- static aliases synchronized, 193 raw / 191 unique / 191 classified,
  unresolved [];
- all dynamic line evidence points at the actual source expression, 224 reads
  scanned / 179 classified rows / unresolved [];
- package and futureAggregate gateway-react records agree on runtime vs dev;
- every generated-root-manifest external reference is covered by initial
  externalPrerequisites with accurate semver/publication evidence;
- initial DAG retains exactly 7 edges, is acyclic, and its order remains valid;
- future aggregate remains acyclic and retains engine -> review;
- root .repos, standalone README/CI, artifactAuthority, facade-last, closure,
  marketing exclusion, licenses, versions, history, symlinks, and drift
  policies remain valid.

REQUIRED OUTPUT:
{
  "summary": "what was repaired",
  "filesChanged": ["exact artifact paths"],
  "exactPathCoverage": true,
  "staticAuditLineEvidenceCurrent": true,
  "dynamicAuditLineEvidenceCurrent": true,
  "gatewayReactDependencyFactsConsistent": true,
  "initialExternalPrerequisitesComplete": true,
  "dagAcyclic": true,
  "priorInvariantsPreserved": true
}
`}
    </Task>
  </Workflow>
));
