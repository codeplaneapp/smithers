// smithers-source: local
// smithers-metadata-version: 1
// smithers-display-name: Federation Static Import Hardening
// smithers-description: Eliminate every unclassified static cross-lane import in the federation plan.
// smithers-tags: maintenance, federation, architecture
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";

const resultSchema = z.object({
  summary: z.string(),
  filesChanged: z.array(z.string()).default([]),
  exactPathCoverage: z.boolean(),
  staticEdgesScanned: z.number().int(),
  staticEdgesClassified: z.number().int(),
  unresolvedStaticEdges: z.array(z.string()).default([]),
  dagAcyclic: z.boolean(),
  priorInvariantsPreserved: z.boolean(),
});

const { Workflow, Task, smithers, outputs } = createSmithers({ result: resultSchema });

export default smithers(() => (
  <Workflow name="federation-static-import-hardening">
    <Task
      id="hardenStaticImports"
      output={outputs.result}
      agent={agents.migrationHard}
      timeoutMs={60 * 60_000}
      heartbeatTimeoutMs={20 * 60_000}
    >
      {`
Repair every remaining static relative cross-lane import in the Smithers
federation artifacts. This is implementation work, not a review.

AUTHORITATIVE READ-ONLY SOURCE:
  /Users/williamcory/smithers-federation-migration-20260727/source-clone
ARTIFACTS YOU MAY EDIT:
  /Users/williamcory/smithers-federation-migration-20260727/artifacts/manifest.json
  /Users/williamcory/smithers-federation-migration-20260727/artifacts/dag.json
  /Users/williamcory/smithers-federation-migration-20260727/artifacts/release-plan.json

Never inspect the dirty live checkout as source evidence. Do not mutate the
source clone, GitHub, workflow code, or repository source. Preserve exact path
coverage, all marketing/** exclusions, versions, license plans, history policy,
OpenClaw phasing, pack test hardening, and initial/future scope.

Run a deterministic scan over every tracked .ts/.tsx/.js/.jsx/.mjs/.cjs source:
extract static relative import/export/require specifiers, resolve them to tracked
paths using normal JS/TS extension and index resolution, then compare manifest
destinations. For EVERY cross-lane edge, classify it in a machine-readable
release-plan audit as exactly one of:
  a. manifest move so source and target become lane-internal;
  b. explicit created-at-split materialized/local fixture with drift policy;
  c. concrete published-package/aggregate-input rewrite with target and version;
  d. proven false positive (prompt/fixture string, type-only, or unreachable
     fallback) with source-line evidence and the actual standalone behavior.
No edge may be merely assumed covered by a broad directory note.

At minimum repair these independently confirmed omissions:

1. Move these three helpers with their importing curated tests to smithers-packs:
   .smithers/tests/curated-authoring-workflows.contracts.ts
   .smithers/tests/curated-ddd-eval-workflows.contracts.ts
   .smithers/tests/curated-system-workflows.contracts.ts
   Update manifest counts, pack test enumeration, packTestMoves evidence, and
   any created/materialized count. They are not retained Smithers tests.

2. examples/mcp-integration/workflow.tsx executes
   packages/agents/tests/fixtures/demo-mcp-server.js, also used by agents tests.
   Give smithers-examples a local materialized fixture (with drift guard) or
   publish a supported fixture; do not leave the repo-relative import.

3. Make these concrete edges explicit and standalone:
   - apps/cli/src/index.js -> apps/observability/package.json;
   - apps/cli/src/installCuratedSkill.js fallbacks ->
     skills/smithers/{SKILL.md,llms-full.txt};
   - apps/cli/tests/claude-mirror-script-harness.e2e.test.js ->
     claude-plugin/workflows/smithers-run.mjs;
   - e2e/degraded-run-surfaces.test.ts ->
     evals/suites/real-usage/cases.jsonl;
   - packages/gateway-client/tests/gateway-client.test.ts ->
     packages/gateway-react/package.json;
   - packages/scorers/tests/eval-writer-skill-doc.test.js ->
     skills/eval-writer/SKILL.md;
   - scripts/optimize-llms-full.ts ->
     skills/smithers/llms-full.txt.
   Decide ownership from real callers. Prefer moving a test with the feature it
   tests, or materializing a small fixture; retained CLI/docs generation must
   use published artifacts or explicit aggregate-local inputs.

4. Re-verify and classify other scanner edges, including:
   - .smithers/lib/plue-provider.test.ts -> root package.json;
   - .smithers/tests/local-workflows-a-queue.test.tsx ->
     packages/testing/src/index.js;
   - examples/init-pack -> examples shared support (the existing 90-file
     materialization plan);
   - packages/pi-plugin/src/extension.ts -> CLI/docs sources;
   - apps/signal -> pack daily-ceo-intel helpers;
   - retained release workflows -> .smithers/agents.ts;
   - packages/testing parity test -> pack components;
   - scripts/sota.test.ts -> pack roles;
   - multi/plue history-lane test imports.
   Retain valid existing rewrites, but the new audit must point to their exact
   plan IDs and leave no unclassified source/target pair.

5. Scan dynamic filesystem reads separately (join/resolve/readFile/readdir using
   import.meta.dir/url) for the same paths. Add a release-plan
   dynamicReadAudit with every known cross-lane read mapped to a plan ID and
   unresolved:[]; preserve the newly repaired pack-test decisions.

6. Synchronize any manifest move with repository counts, repo package/test
   plans, DAG/release ordering when needed, and docs/CI checks. Avoid inventing
   packages. Keep the initial DAG acyclic.

Hard validation before returning:
- manifest path set equals clean-clone git ls-files exactly: 8,835 unique;
- every manifest package subtree matches its package record repo;
- all static cross-lane resolved edges are classified and unresolved is [];
- all detected dynamic cross-lane reads are classified and unresolved is [];
- every materialization appears in createdAtSplitFiles and has a drift/update
  policy unless it is an immutable local test fixture;
- top-level and scopes.initial edges/order match and remain topological;
- initial dependency closure remains complete;
- marketing/license/version/history/facade-last invariants are unchanged.

REQUIRED OUTPUT:
{
  "summary": "what was repaired",
  "filesChanged": ["exact artifact paths"],
  "exactPathCoverage": true,
  "staticEdgesScanned": 0,
  "staticEdgesClassified": 0,
  "unresolvedStaticEdges": [],
  "dagAcyclic": true,
  "priorInvariantsPreserved": true
}
`}
    </Task>
  </Workflow>
));
