// smithers-source: local
// smithers-metadata-version: 1
// smithers-display-name: Federation Dynamic Read Hardening
// smithers-description: Repair every Luna-discovered dynamic cross-lane filesystem read.
// smithers-tags: maintenance, federation, architecture
/** @jsxImportSource smthrs */
import { createSmithers } from "smthrs";
import { z } from "zod/v4";
import { agents } from "../agents";

const resultSchema = z.object({
  summary: z.string(),
  filesChanged: z.array(z.string()).default([]),
  exactPathCoverage: z.boolean(),
  staticResolved: z.number().int(),
  staticClassified: z.number().int(),
  dynamicResolved: z.number().int(),
  dynamicClassified: z.number().int(),
  unresolvedStatic: z.array(z.string()).default([]),
  unresolvedDynamic: z.array(z.string()).default([]),
  dagAcyclic: z.boolean(),
  priorInvariantsPreserved: z.boolean(),
});

const { Workflow, Task, smithers, outputs } = createSmithers({ result: resultSchema });

export default smithers(() => (
  <Workflow name="federation-dynamic-read-hardening">
    <Task
      id="hardenDynamicReads"
      output={outputs.result}
      agent={agents.migrationHard}
      timeoutMs={60 * 60_000}
      heartbeatTimeoutMs={20 * 60_000}
    >
      {`
Repair every dynamic cross-lane filesystem read independently found by the
Luna xhigh audit of the Smithers federation artifacts. Implementation only.

AUTHORITATIVE READ-ONLY SOURCE:
  /Users/williamcory/smithers-federation-migration-20260727/source-clone
ARTIFACTS YOU MAY EDIT:
  /Users/williamcory/smithers-federation-migration-20260727/artifacts/manifest.json
  /Users/williamcory/smithers-federation-migration-20260727/artifacts/dag.json
  /Users/williamcory/smithers-federation-migration-20260727/artifacts/release-plan.json

Never use the dirty live checkout as source evidence. Do not mutate source-clone,
GitHub, workflow source, or repository code. Preserve exact path coverage,
marketing exclusion, versions, MIT plans, history policy, facade-last,
OpenClaw phasing, pack-test ownership, and all established rewrites.

The independent Luna run 665001bc-4284-48c8-9611-f04850205c68 verified the
manifest, package ownership, licenses, versions, marketing, materializations,
static audit, DAG, dependency closure, history lanes and facade-last, but
returned approvable:false. It resolved 188 static edges while the artifact
classified only 187 (unresolved list incorrectly empty), and found these exact
unclassified dynamic read groups:

1. .smithers/workflows/smoketest.tsx -> package.json, docs/changelogs/, docs
   guides, skills/smithers/SKILL.md.
2. scripts/generate-workflow-pack.ts -> .smithers/{workflows,prompts,lib,ui}.
3. apps/cli/scripts/build-ui.mjs -> apps/smithers/.
4. scripts/bump.mjs -> .smithers/lib/plue-provider.ts and moved workspace manifests.
5. scripts/check-docs.mjs -> moved multi, agents, sandboxes, examples, other lanes.
6. scripts/check-dts.mjs -> moved package subtrees.
7. scripts/check-llms.mjs -> skills/smithers/llms-full.txt.
8. scripts/check-no-direct-db-access.mjs -> moved package source trees.
9. scripts/check-ui-architecture.mjs -> .smithers/ui, examples/ui, moved multi UI.
10. scripts/coverage.mjs -> moved package/app subtrees.
11. scripts/publish.mjs and scripts/publish-next.mjs -> moved workspace manifests.
12. scripts/sota-research.ts -> .smithers/ and apps/review/.
13. apps/cli/tests/docs-public-surface-coverage.test.js -> packages/agents,
    apps/observability, .smithers/workflows.
14. apps/cli/tests/examples-init-pack.test.js -> examples/init-pack and
    examples/ui/review.tsx.
15. apps/cli/tests/examples-graph-smoke.test.js -> examples/smoketest.jsx.
16. apps/cli/tests/examples-tsconfig-published-types.test.js -> examples/tsconfig.json.
17. apps/cli/tests/context-engineer-skill.test.js -> skills/context-engineer and
    examples/init-pack.
18. apps/cli/tests/smithers-skill-contract.test.js -> skills/smithers and
    claude-plugin/skills/smithers.
19. apps/cli/tests/make-workflow-tutorial.test.js -> examples/init-pack and
    .smithers/workflows.
20. apps/cli/tests/eval-suite-run.e2e.test.js ->
    .smithers/workflows/eval-suite-run.tsx.
21. apps/cli/tests/observability-package.test.js -> apps/observability and
    skills/smithers.
22. apps/cli/tests/workflow-pack-component-drift.test.js -> canonical
    .smithers/agents and .smithers/workflows.
23. apps/cli/tests/seeded-pack-fresh.test.js -> canonical .smithers sources.
24. apps/ferric-site/scripts/{build-site,build-source}.mjs ->
    .smithers/{workflows,prompts,components,ui}.
25. benchmarks/kanban-bench/{bench,sandbox}.ts -> packages/smithers and
    .smithers/{workflows,components,ui,prompts}.
26. benchmarks/orchbench/collect_cell.ts -> apps/cli/src/index.js.
27. evals/harness/run-suite.ts -> apps/cli/src/index.js.
28. packages/agents/tests/cli-capabilities.test.js ->
    docs/integrations/cli-agents.mdx.
29. packages/gateway-react/tests/docsExamplesCompile.test.ts -> docs/examples
    and packages/gateway-client/src.
30. packages/server/src/gatewayUi/bundle.js -> packages/gateway-react and
    packages/gateway-client source trees.
31. packages/smithers/tests/package-and-build-contract.test.js -> moved package
    and app manifests.
32. skills/report-maker/SKILL.test.js ->
    .smithers/workflows/report-slideshow.tsx.
33. .smithers/workflows/daily-benchmark-maintenance.tsx ->
    benchmarks/results.json and evals/suites.
34. .smithers/workflows/real-stack-e2e.tsx ->
    apps/smithers/.env.e2e.local and apps/smithers/.gitignore.

For each group inspect source and callers, then make an explicit executable
ownership decision:
- move a feature-specific test/build script with its owner when clean;
- use a published package/artifact with an exact semver for runtime consumers;
- use the aggregate-local repos/<lane> layout for root coordinator scripts that
  intentionally span repos;
- use a small created-at-split fixture with drift policy for stable test inputs;
- use explicit workflow input paths for pack workflows;
- classify only genuine prompt/tmp-fixture false positives with line evidence.

Root Smithers must remain the aggregate release coordinator. Therefore
scripts/bump*, publish*, check-docs/check-dts/check-no-direct-db-access,
coverage, and other genuinely fleet-wide checks should become .repos-aware
aggregate scripts, not be deleted or narrowed silently. Per-repo checks may
also be generated, but the root command must still validate/publish all repos
in topological order with the facade last.

The server UI bundle is runtime-significant: replace source-tree resolution
with an actual published gateway UI/client artifact or explicitly staged
package asset in the future multi->Smithers rewire; order it so retained server
builds keep working before and after the move. Do not leave a source read.

Rebuild staticEdgeAudit and dynamicReadAudit from deterministic scanners after
all decisions. The audits must include every resolved source/target pair,
reference existing unique plan IDs (or named future plan objects), and have
resolved == classified with unresolved:[]. Correct Luna's 188-vs-187 static
mismatch rather than hiding it.

Hard validation:
- exactly 8,835 unique manifest paths equal clean-clone git ls-files;
- every package subtree matches package record ownership;
- all static resolved edges classified, unresolved [];
- all dynamic resolved reads classified, unresolved [];
- every created file explicit with update/drift policy;
- root aggregate scripts cover all repos and root publish remains topological;
- top/scoped initial DAG synchronized, acyclic, dependency closure complete;
- prior marketing/license/version/history/symlink/facade invariants preserved.

REQUIRED OUTPUT:
{
  "summary": "what was repaired",
  "filesChanged": ["exact artifact paths"],
  "exactPathCoverage": true,
  "staticResolved": 0,
  "staticClassified": 0,
  "dynamicResolved": 0,
  "dynamicClassified": 0,
  "unresolvedStatic": [],
  "unresolvedDynamic": [],
  "dagAcyclic": true,
  "priorInvariantsPreserved": true
}
`}
    </Task>
  </Workflow>
));
