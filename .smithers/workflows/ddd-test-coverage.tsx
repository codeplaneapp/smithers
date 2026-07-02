// smithers-display-name: DDD Test Coverage Loop
// smithers-description: Loop a test-candidate finder and an implementer over the docs-driven-development surface until the finder declares coverage 100% comprehensive.
/** @jsxImportSource smithers-orchestrator */
import { createSmithers, Loop, Sequence, Task } from "smithers-orchestrator";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod/v4";
import { providers } from "../agents";

function resolveRepoRoot(): string {
  let dir = resolve(process.cwd());
  for (;;) {
    if (existsSync(resolve(dir, ".smithers/spec/features.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}
const ROOT = resolveRepoRoot();

const finderAgent = providers.codex;
const implementer = providers.codex;

const inputSchema = z.object({
  maxRounds: z.preprocess((v) => v ?? undefined, z.number().int().min(1).max(1000).default(1000)),
});

const findSchema = z.object({
  comprehensive: z.boolean().default(false),
  candidates: z.array(z.object({
    id: z.string(),
    title: z.string(),
    kind: z.enum(["unit", "e2e"]),
    targetFiles: z.array(z.string()).default([]),
    rationale: z.string().default(""),
  })).default([]),
  coveredAreas: z.array(z.string()).default([]),
  gaps: z.array(z.string()).default([]),
  summary: z.string().default(""),
});

const implementSchema = z.object({
  status: z.enum(["done", "partial", "blocked", "skipped"]).default("skipped"),
  testFilesWritten: z.array(z.string()).default([]),
  commandsRun: z.array(z.string()).default([]),
  summary: z.string().default(""),
});

const verifySchema = z.object({
  passed: z.boolean().default(false),
  command: z.string().default(""),
  summary: z.string().default(""),
});

const { Workflow, smithers, outputs } = createSmithers({
  input: inputSchema,
  find: findSchema,
  fable: findSchema,
  implement: implementSchema,
  verify: verifySchema,
});

const SURFACE = `
The docs-driven-development (DDD) surface in this repo (root: ${ROOT}):
- Scripts: .smithers/lib/ddd/*.ts (featuresSchema, validateFeatures, generateSpecDocs, generateUiModules, auditInputs, triageCandidates, build, dddRoot).
- Workflow: .smithers/workflows/docs-driven-development.tsx (node graph, loop-exit corroboration via featuresStillIncomplete, metaTicket bounded-field spill, materializeTriageTickets, agent routing).
- UI: .smithers/ui/docs-driven-development.tsx + ddd-shared.tsx + ddd-{Specs,Features,Audit,Live,Tickets}Tab.tsx (Crepe editor, dispatch flow, frame parsers chatLineFromFrame/chatLinesFromFrame/buildChatLines/logLineFromFrame, resolveDocLink, SpecFileTree, FeatureDetail).
- Spec data: .smithers/spec/features.json + content/.
Design spec: .smithers/specs/docs-driven-development.md.

Testing conventions (MANDATORY):
- Tests live in .smithers/tests/ or next to the UI files, run with bun test from .smithers.
- NO MOCKS: real fs in temp dirs, real engine runs with a seeded fake agent (see .smithers/tests/open-code-review.test.ts + openCodeReviewRunFixture.ts), real gateway + real browser for UI e2e (see open-code-review-ui.e2e.test.ts, ship-pipeline-ui.e2e.test.tsx). CI has no browsers/agent CLIs: browser e2e must skip cleanly when no browser is available, engine tests must seed a fake agent.
- The bar (extreme): unit tests exhaustive over branches/edge cases (invalid features.json shapes, stale derived-doc deletion, ticket ranking order, bounded-field truncation + artifact spill, root discovery from nested cwd); e2e proves the real thing end to end (workflow run produces node outputs and tickets; UI renders all five tabs, feature modal, tree selection, Crepe edit enables dispatch, dispatch launches a real run, no console errors). The two suites must EACH independently give high confidence.
`;

// Done only when BOTH finders agree there is nothing left AND the whole suite
// passes: codex (primary) says comprehensive with zero candidates, then the
// claude-fable-5 second-opinion pass also finds nothing.
function coverageComplete(ctx: any): boolean {
  const find = ctx.outputMaybe(outputs.find, { nodeId: "find-candidates" });
  const fable = ctx.outputMaybe(outputs.fable, { nodeId: "fable-check" });
  const verify = ctx.outputMaybe(outputs.verify, { nodeId: "verify" });
  return (
    find?.comprehensive === true &&
    (find?.candidates?.length ?? 0) === 0 &&
    fable?.comprehensive === true &&
    (fable?.candidates?.length ?? 0) === 0 &&
    verify?.passed === true
  );
}

export default smithers((ctx) => {
  const maxRounds = Number(ctx.input.maxRounds) >= 1 ? Number(ctx.input.maxRounds) : 1000;
  return (
    <Workflow name="ddd-test-coverage">
      <Loop id="coverage-loop" until={coverageComplete(ctx)} maxIterations={maxRounds} onMaxReached="return-last">
        <Sequence>
          <Task id="find-candidates" output={outputs.find} agent={finderAgent} retries={1} timeoutMs={20 * 60 * 1000}>
            {`You are the test-candidate finder for the DDD surface. Enumerate every behavior of every file in the surface, diff that against the CURRENT test files (ls .smithers/tests, .smithers/ui/*.test.*, .smithers/lib/ddd/*.test.*; read them), and list the highest-value missing tests as candidates (at most 6 per round, most valuable first). Be adversarial: branches, error paths, empty/None/null inputs, camelCase vs snake_case rows, truncation limits, CI-skip behavior, regressions for the hard-won fixes noted in comments. Set comprehensive=true with ZERO candidates ONLY when unit tests and e2e tests EACH independently give near-100% confidence the whole DDD surface works with no UI bugs; otherwise comprehensive=false. Do not write any files. Return only JSON matching the find schema. ${SURFACE}`}
          </Task>
          {/* Second-opinion finder: claude-fable-5. Cheap no-op while codex is
              still iterating; a real adversarial hunt once codex claims done. */}
          <Task
            id="fable-check"
            output={outputs.fable}
            agent={providers.claude}
            retries={1}
            timeoutMs={20 * 60 * 1000}
            dependsOn={["find-candidates"]}
            needs={{ find: "find-candidates" }}
            deps={{ find: outputs.find }}
          >
            {(deps: any) =>
              deps.find?.comprehensive === true && (deps.find?.candidates?.length ?? 0) === 0
                ? `Codex has declared DDD test coverage 100% comprehensive. You are the adversarial second-opinion finder. Independently enumerate the DDD surface behaviors, read every existing DDD test, and hunt for anything codex missed (UI edge cases, race/ordering issues, CI-skip correctness, regression coverage for commented fixes). Set comprehensive=true with ZERO candidates only if you genuinely find nothing worth adding; otherwise list candidates (max 6). Do not write files. Return only JSON matching the find schema. ${SURFACE}`
                : `Codex is still iterating (its finder has open candidates or comprehensive=false). Do nothing. Return only JSON: {"comprehensive": false, "candidates": [], "coveredAreas": [], "gaps": [], "summary": "deferred until codex declares comprehensive"}.`
            }
          </Task>
          <Task
            id="implement"
            output={outputs.implement}
            agent={implementer}
            retries={1}
            timeoutMs={60 * 60 * 1000}
            dependsOn={["fable-check"]}
            needs={{ find: "find-candidates", fable: "fable-check" }}
            deps={{ find: outputs.find, fable: outputs.fable }}
          >
            {(deps: any) => {
              const candidates = [
                ...(deps.find?.candidates ?? []),
                ...(deps.fable?.candidates ?? []),
              ];
              return candidates.length === 0
                ? `No candidates this round. Return JSON matching the implement schema with status "skipped".`
                : `Implement these test candidates now, following the conventions exactly (no mocks, CI-safe skips, bun test). After writing each test, RUN it (cd .smithers && bun test <file>) and fix failures — including real product bugs the tests expose (fix the product code in the DDD surface, never weaken the test; do NOT touch .smithers/workflows/ddd-test-coverage.tsx). Keep pnpm -C .smithers typecheck green. Return only JSON matching the implement schema.

Candidates:
${JSON.stringify(candidates, null, 2)}
${SURFACE}`;
            }}
          </Task>
          <Task id="verify" output={outputs.verify} dependsOn={["implement"]}>
            {async () => {
              const command = "bun test ./tests ./ui ./lib --timeout 120000";
              try {
                const out = execFileSync("bun", ["test", "./tests", "./ui", "./lib", "--timeout", "120000"], {
                  cwd: resolve(ROOT, ".smithers"),
                  encoding: "utf8",
                  stdio: ["ignore", "pipe", "pipe"],
                  maxBuffer: 32 * 1024 * 1024,
                });
                return { passed: true, command, summary: out.split("\n").slice(-6).join("\n") };
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return { passed: false, command, summary: `bun test failed: ${message.slice(0, 4000)}` };
              }
            }}
          </Task>
        </Sequence>
      </Loop>
    </Workflow>
  );
});
