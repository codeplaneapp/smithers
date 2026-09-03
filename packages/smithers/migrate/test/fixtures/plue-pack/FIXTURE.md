# Fixture: `plue-pack`

A multi-workflow Smithers 0.x `.smithers` pack from a real external project. It carries the pre-rename package name `smithers-orchestrator`, shared components, MDX prompts, an agent pool, a workflow-specific UI, and one workflow written against a foreign authoring API.

Origin: `/Users/williamcory/plue/.smithers` at Plue commit `2db1ecff21f7da8101f466570a6b997285eae394` (2026-08-28).

Every file under `.smithers/` is a byte-for-byte copy of the origin path of the same name, except for the one sanitization below.

Sanitizations, and nothing else:

- `.smithers/workflows/pipelines/lib.ts`: `import { writeReceipt } from "../../../scripts/ci-receipt"` becomes a local `writeReceipt` stub, because the origin module lives outside the copied pack.
- `.smithers/workflows/release.tsx` is kept verbatim. It imports `@smithers-ai/workflow`, a foreign authoring API, and is the `unknown-authoring-api` case.

Authored, because the origin repository holds them outside `.smithers/`:

- `package.json`: the workspace root that makes `.smithers` a workspace member, with two old CLI scripts (`smithers workflow run` and `bunx smthrs up ... -d`).
- `CLAUDE.md`: one `smithers up` sentence, the documentation-rewrite case.

`.smithers/package.json` is now copied verbatim. It pins `smithers-orchestrator@0.32.0` and `zod@4.5.2`; an earlier copy of this fixture rewrote a `file:` spec to `0.28.0` and drifted from the origin's dependency versions. `Detect.classifyPackage` covers the `file:` spelling directly in `test/Detect.test.ts`, so the fixture does not have to carry it.

`.smithers/ui/pipelines-ci-fast.tsx` imports `./pipelines-shared`, which the origin holds and this copy does not. The scanner never resolves UI imports, so the dangling specifier is deliberate and harmless.
