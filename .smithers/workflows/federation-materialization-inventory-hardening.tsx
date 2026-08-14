// smithers-source: local
// smithers-metadata-version: 1
// smithers-display-name: Federation Materialization Inventory Hardening
// smithers-description: Inventory every planned split-time materialization with exact update and drift policy.
// smithers-tags: maintenance, federation, architecture
/** @jsxImportSource smthrs */
import { createSmithers } from "smthrs";
import { z } from "zod/v4";
import { agents } from "../agents";

const resultSchema = z.object({
  summary: z.string(),
  filesChanged: z.array(z.string()).default([]),
  materializationsAdded: z.array(z.string()).default([]),
  exactPathCoverage: z.boolean(),
  allPlannedMaterializationsInventoried: z.boolean(),
  staticAuditPreserved: z.boolean(),
  dynamicAuditPreserved: z.boolean(),
  dagAcyclic: z.boolean(),
  priorInvariantsPreserved: z.boolean(),
});

const { Workflow, Task, smithers, outputs } = createSmithers({ result: resultSchema });

export default smithers(() => (
  <Workflow name="federation-materialization-inventory-hardening">
    <Task
      id="inventoryAllMaterializations"
      output={outputs.result}
      agent={agents.migrationHard}
      timeoutMs={60 * 60_000}
      heartbeatTimeoutMs={20 * 60_000}
    >
      {`
Repair only the split-time materialization inventory and policy omissions found
by the fresh independent Luna xhigh audit, run
0204a89c-2c43-42fb-b9ab-3ad413691795 node auditStaticImports.

AUTHORITATIVE READ-ONLY SOURCE:
  /Users/williamcory/smithers-federation-migration-20260727/source-clone
ARTIFACTS YOU MAY EDIT:
  /Users/williamcory/smithers-federation-migration-20260727/artifacts/manifest.json
  /Users/williamcory/smithers-federation-migration-20260727/artifacts/dag.json
  /Users/williamcory/smithers-federation-migration-20260727/artifacts/release-plan.json

Never inspect the dirty live checkout as source evidence. Do not mutate the
source clone, GitHub, workflow code, or repository source. Preserve ownership,
exact path coverage, dependency facts, static/dynamic rows, and the DAG.

The audit verified all other architecture invariants and returned
approvable:false only because these already-planned materializations lack exact
createdAtSplitFiles inventory entries and/or explicit update/drift policy:

1. signalDailyCeoIntel:
   apps/signal/lib/cloudflare.ts and apps/signal/lib/render.ts.
2. localUiServerHelper:
   every materialized destination under apps/smithers.
3. monitorPromptFixture:
   examples/tests/fixtures/MonitorPrompt.mdx.
4. testingParityComponents:
   every fixture copy under packages/testing/tests/fixtures.
5. facadeTestHelpers:
   every helper copy under packages/agents/tests and
   packages/integrations/tests; inventory each exact destination, not a
   directory wildcard.
6. buildToolingEnumeration:
   the declaration-entries.mjs copy in the smithers-integrations repo.
7. electricProviderParity:
   packages/gateway-react/tests/fixtures/electricFixture.ts in multi.
8. gatewayWorkflowDiscovery:
   .smithers/tests/gateway-discovery.test.ts.

For every family:
- inspect the existing crossRepoRewrites plan and authoritative source paths;
- enumerate every exact destination path and owning repo;
- add one createdAtSplitFiles record per exact destination;
- make purpose evidence name planId, canonical source, creation ordering,
  immutable-vs-synchronized update policy, drift guard/check command, and
  validation;
- if the existing rewrite plan lacks any of those fields, strengthen the plan
  narrowly and keep createdAtSplitFiles synchronized;
- distinguish truly generated/new-owned tests from byte-identical copies.
  New-owned tests need an explicit owner/update policy but no fake upstream
  drift contract. Copies must be refreshed only from their canonical source and
  must have a concrete CI drift guard.

Do not create wildcard inventory records. Do not add source snapshot paths to
manifest.json: these are target-repo files created during extraction. Do not
invent materializations beyond what the named plans actually require.

Validation after editing:
- source clone clean at pinned commit
  505717d175d5ef51b3b164aba5cbe969f805e2fe;
- manifest remains exactly 8,835 unique paths equal to git ls-files;
- every destination named by any crossRepoRewrites materialization/copy/vendor/
  generated-fixture plan has an exact createdAtSplitFiles record, correct repo,
  canonical source or new-owner policy, ordering, drift/update policy, and
  validation;
- no createdAtSplitFiles duplicate repo/path keys and no wildcard paths;
- static aliases remain synchronized, 193 raw / 191 unique / unresolved [];
- dynamic audit remains 224 reads / 179 classified rows / unresolved [];
- initial DAG retains exactly 7 edges and remains acyclic/topological;
- future aggregate remains acyclic with engine -> review;
- prerequisite closure, gateway-react dependency facts, standalone README/CI,
  artifactAuthority, root .repos, facade-last, marketing exclusion, licenses,
  versions, history, symlinks, and all prior drift policies remain valid.

REQUIRED OUTPUT:
{
  "summary": "what was inventoried",
  "filesChanged": ["exact artifact paths"],
  "materializationsAdded": ["exact repo:path keys"],
  "exactPathCoverage": true,
  "allPlannedMaterializationsInventoried": true,
  "staticAuditPreserved": true,
  "dynamicAuditPreserved": true,
  "dagAcyclic": true,
  "priorInvariantsPreserved": true
}
`}
    </Task>
  </Workflow>
));
