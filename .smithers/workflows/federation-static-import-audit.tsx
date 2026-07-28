// smithers-source: local
// smithers-metadata-version: 1
// smithers-display-name: Federation Static Import Audit
// smithers-description: Read-only Luna audit of cross-lane static and dynamic source edges.
// smithers-tags: validation, federation, architecture
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";

const resultSchema = z.object({
  approvable: z.boolean(),
  sourceCommit: z.string(),
  trackedPaths: z.number().int(),
  sourceFilesScanned: z.number().int(),
  resolvedStaticEdges: z.number().int(),
  classifiedStaticEdges: z.number().int(),
  unresolvedStaticEdges: z.array(z.string()).default([]),
  unresolvedDynamicReads: z.array(z.string()).default([]),
  manifestErrors: z.array(z.string()).default([]),
  dagErrors: z.array(z.string()).default([]),
  summary: z.string(),
});

const { Workflow, Task, smithers, outputs } = createSmithers({ result: resultSchema });

export default smithers(() => (
  <Workflow name="federation-static-import-audit">
    <Task
      id="auditStaticImports"
      output={outputs.result}
      agent={agents.migrationEasy}
      timeoutMs={45 * 60_000}
      heartbeatTimeoutMs={15 * 60_000}
    >
      {`
Perform a READ-ONLY independent audit of the Smithers federation artifacts.
Do not edit any file or mutate GitHub.

AUTHORITATIVE SOURCE:
  /Users/williamcory/smithers-federation-migration-20260727/source-clone
ARTIFACTS:
  /Users/williamcory/smithers-federation-migration-20260727/artifacts

Never inspect the dirty live checkout as source evidence. Verify source-clone is
clean and HEAD == origin/main. Verify manifest paths exactly equal git ls-files.

Deterministically scan every tracked .ts/.tsx/.js/.jsx/.mjs/.cjs source for
static relative import/export/require specifiers. Resolve normal JS/TS
extensions, index files, JSON, and package.json. For every source/target pair
whose manifest destinations differ, find its exact classification in
release-plan.json staticImportAudit and verify the referenced move, plan ID,
materialization, semver rewrite, or false-positive evidence is concrete.

Separately scan join/resolve/readFile/readdir patterns rooted at import.meta.dir
or import.meta.url and verify every cross-lane filesystem read is classified in
dynamicReadAudit. Do not count prompt prose or tmp-fixture paths as source reads,
but require evidence for excluding them.

Also verify:
- 8,835 unique manifest paths, exact git equality;
- every package subtree owner matches its package record;
- static/dynamic audit unresolved arrays are empty;
- every created-at-split materialization is explicit and has a drift/update
  policy unless immutable test fixture;
- top-level and scopes.initial edges/order match and are topological;
- initial dependency closure, marketing exclusion, MIT coverage, versions,
  history lanes, and facade-last remain valid.

Return approvable:false for any unclassified source/target pair or factual
disagreement. Name exact files.

REQUIRED OUTPUT:
{
  "approvable": false,
  "sourceCommit": "",
  "trackedPaths": 0,
  "sourceFilesScanned": 0,
  "resolvedStaticEdges": 0,
  "classifiedStaticEdges": 0,
  "unresolvedStaticEdges": [],
  "unresolvedDynamicReads": [],
  "manifestErrors": [],
  "dagErrors": [],
  "summary": ""
}
`}
    </Task>
  </Workflow>
));
