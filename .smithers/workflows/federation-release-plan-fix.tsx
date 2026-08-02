// smithers-source: local
// smithers-metadata-version: 1
// smithers-display-name: Federation Release Plan Fix
// smithers-description: Repair rejected package scopes and dependency rewrites in the federation release artifacts.
// smithers-tags: maintenance, federation, release
/** @jsxImportSource smthrs */
import { createSmithers } from "smthrs";
import { z } from "zod/v4";
import { agents } from "../agents";

const resultSchema = z.object({
  summary: z.string(),
  filesChanged: z.array(z.string()).default([]),
  exactPathCoverage: z.boolean(),
  initialDagAcyclic: z.boolean(),
  initialPlanExecutable: z.boolean(),
  futurePlanExecutable: z.boolean(),
  licensePlansComplete: z.boolean(),
  remainingRisks: z.array(z.string()).default([]),
});

const { Workflow, Task, smithers, outputs } = createSmithers({ result: resultSchema });

export default smithers(() => (
  <Workflow name="federation-release-plan-fix">
    <Task
      id="fix"
      output={outputs.result}
      agent={agents.migrationHard}
      timeoutMs={60 * 60_000}
      heartbeatTimeoutMs={20 * 60_000}
    >
      {`
Fix the rejected Smithers federation release artifacts. Edit ONLY:

- /Users/williamcory/smithers-federation-migration-20260727/artifacts/manifest.json
- /Users/williamcory/smithers-federation-migration-20260727/artifacts/dag.json
- /Users/williamcory/smithers-federation-migration-20260727/artifacts/release-plan.json

Use ONLY this clean source snapshot as evidence:
/Users/williamcory/smithers-federation-migration-20260727/source-clone

Never inspect the live /Users/williamcory/smithers checkout. Do not edit the
clean clone, workflow files, prompts, UI, GitHub, or any repository.

Preserve every passing invariant:
- manifest is the exact unique 8,835-path set from source-clone git ls-files;
- all marketing/** remains stays-in-smithers and absent from examples packages;
- the curated .smithers ownership remains;
- ten exact new repos, multi/plue future targets, awesome-smithers docs-only;
- initial ten-repo DAG remains acyclic;
- MIT LICENSE copy plans remain explicit;
- multi/plue packages remain future-only until their PRs merge;
- facade remains final/meta in future aggregate publication;
- OpenClaw CLI semver rewire remains modeled.

Fix every rejection:

1. Remove smthrs from all initial externalPrerequisites. The
   facade is never an upstream prerequisite; it is republished last.

2. packages/agent-eliza currently imports the facade. Keep smithers-agents as
   an initial repository and @smthrs/agents as an initial npm
   package, but make @smthrs/agent-eliza future/deferred unless
   you can specify a concrete, verified facade-free dependency rewrite. Model
   its source dependencies separately from its post-decoupling dependencies and
   a precise rewritePlan. It must not block the initial repo release.

3. apps/review currently imports smthrs and the future multi
   package @smthrs/ui-styleguide. Keep the smithers-review repo
   in the initial federation (GitHub release allowed), but move its npm package
   to future/deferred until multi's history-merge PR is merged AND the lane
   decoupling removes the facade dependency onto verified concrete core APIs.
   Model sourceDependsOn, postDecoupleDependsOn, blockedUntil, and rewritePlan.
   Future aggregate ordering must put multi before smithers-review and the
   facade final/meta after all extension packages.

4. Add awesome-smithers as scope:"never", npmPublished:false, docs-only repo
   record with license:"MIT", licenseSource:"LICENSE", and explicit copy plan.
   It has zero packages and is never released to npm.

5. apps/smithers moves to multi while apps/cli stays in Smithers and currently
   builds it from source. Model the future @smthrs/smithers-ui
   package/bundle and a concrete CLI semver consumption rewrite after the
   history-merge. It must not be part of initial publication.

6. config/sources.json and config/ceo-intel.json are owned by smithers-signal
   but consumed by smithers-packs and Smithers tests. Add a concrete
   crossRepoRewrites plan: reusable packs accept config as workflow input; core
   tests use a local fixture. No lane may retain repo-relative cross-repo reads.

7. In every repo with multiple npm packages (especially smithers-sandboxes),
   add a verified package-level publicationOrder/topological order so the base
   package publishes before providers.

8. Zero-npm repos may contain examples importing a previously published facade;
   model that as a runtime/dev external dependency in their generated root
   manifests, not as an initial publication DAG edge.

Run hard validations:
- manifest exact set equality and unique count against source-clone;
- no marketing overlap;
- exact ten initial repos and valid topological order;
- every initial npm package has only initial-planned or allowed concrete core
  prerequisites, never facade or future packages;
- every future package has explicit blockers/order and post-decouple deps;
- no smthrs in externalPrerequisites;
- awesome-smithers license record exists;
- all repo license plans complete;
- every dependsOn/rewrite target resolves.

REQUIRED OUTPUT:
{
  "summary": "what changed",
  "filesChanged": ["exact paths"],
  "exactPathCoverage": true,
  "initialDagAcyclic": true,
  "initialPlanExecutable": true,
  "futurePlanExecutable": true,
  "licensePlansComplete": true,
  "remainingRisks": []
}
`}
    </Task>
  </Workflow>
));
