// smithers-display-name: DDD Improve Loop
// smithers-description: Loop a codex finder, a claude-fable-5 adversarial second opinion, and a codex implementer over the docs-driven-development surface until both declare it done. focus="quality" polishes the app; focus="tests" drives test coverage.
/** @jsxImportSource smithers-orchestrator */
import { createSmithers, Loop, Sequence, Task } from "smithers-orchestrator";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { z } from "zod/v4";
import { providers } from "../agents";
import { dddRootOrCwd } from "../lib/ddd/dddRoot.ts";

const ROOT = dddRootOrCwd();

const codex = providers.codex;
const fable = providers.claude; // claude-fable-5

const inputSchema = z.object({
  focus: z.preprocess((v) => v ?? undefined, z.enum(["quality", "tests"]).default("quality")),
  maxRounds: z.preprocess((v) => v ?? undefined, z.number().int().min(1).max(1000).default(1000)),
});

// One finder shape for both focuses: quality issues and missing tests are both
// just "candidates the implementer should apply".
const findSchema = z.object({
  comprehensive: z.boolean().default(false),
  candidates: z.array(z.object({
    id: z.string(),
    title: z.string(),
    kind: z.enum(["ui-format", "css", "code-quality", "missing-feature", "bug", "unit", "e2e"]),
    targetFiles: z.array(z.string()).default([]),
    detail: z.string().default(""),
  })).default([]),
  summary: z.string().default(""),
});

const implementSchema = z.object({
  status: z.enum(["done", "partial", "blocked", "skipped"]).default("skipped"),
  filesChanged: z.array(z.string()).default([]),
  commandsRun: z.array(z.string()).default([]),
  summary: z.string().default(""),
});

const verifySchema = z.object({
  passed: z.boolean().default(false),
  summary: z.string().default(""),
});

const { Workflow, smithers, outputs } = createSmithers({
  input: inputSchema,
  find: findSchema,
  fable: findSchema,
  implement: implementSchema,
  verify: verifySchema,
});

const SHARED_SURFACE = `
The docs-driven-development (DDD) surface in this repo (root: ${ROOT}):
- Scripts: .smithers/lib/ddd/*.ts (featuresSchema, validateFeatures, generateSpecDocs, generateUiModules, auditInputs, triageCandidates, build, dddRoot).
- Workflows: .smithers/workflows/docs-driven-development.tsx, ddd-generate-docs.tsx, ddd-bug-scan.tsx.
- UI: .smithers/ui/docs-driven-development.tsx + ddd-shared.tsx + ddd-{Specs,Features,Audit,Live,Tickets}Tab.tsx + ddd-StartPane.tsx + ddd-Tutorial.tsx (rendered via smithers ui / gateway-react; Milkdown Crepe editor).
- Spec data: .smithers/spec/features.json + content/.
Design spec: .smithers/specs/ddd-app-v2.md.

Hard rules:
- Gate command: cd ${ROOT}/.smithers && bun lib/ddd/build.ts, then pnpm typecheck, then bun test ./tests ./ui ./lib.
- NEVER edit .smithers/workflows/ddd-improve.tsx (THIS running workflow) — record such findings in your summary instead. Editing other DDD workflow files is allowed only for real bugs.
- No mocks anywhere. CI has no browsers or agent CLIs: browser e2e must skip cleanly, engine tests must seed a fake agent. No em-dashes in user-facing prose.
- Commit nothing.
`;

export const FOCUS_BARS = {
  quality: `
Focus: PRODUCT QUALITY. Judge the DDD app the way a picky user and a picky staff
engineer would: open every UI file, read the CSS, read the scripts, imagine
every tab in the browser. Quality bar: everything that should be formatted IS
formatted (dates, counts, statuses, long text truncation), consistent
spacing/typography, polished CSS in light AND dark, empty/loading/error states
everywhere, no raw JSON dumps shown to users, keyboard/hover affordances, no
layout jank, readable script errors, quality overview prose. Small high-value
missing features (search/filter, unsaved indicators, ticket detail polish)
count as candidates too.`,
  tests: `
Focus: TEST COVERAGE. Enumerate every behavior of every file in the surface,
diff that against the CURRENT test files (ls .smithers/tests, .smithers/ui/*.test.*,
.smithers/lib/ddd/*.test.*; read them), and list the highest-value missing
tests. Be adversarial: branches, error paths, empty/null inputs, camelCase vs
snake_case rows, truncation limits, CI-skip behavior, regressions for the
hard-won fixes noted in comments. Tests live in .smithers/tests/ or next to the
UI files and run with bun test from .smithers. The bar is extreme: unit tests
and e2e tests must EACH independently give near-100% confidence.`,
} as const;

export function improveComplete(ctx: any): boolean {
  const find = ctx.outputMaybe(outputs.find, { nodeId: "find" });
  const fable = ctx.outputMaybe(outputs.fable, { nodeId: "second-opinion" });
  const verify = ctx.outputMaybe(outputs.verify, { nodeId: "verify" });
  return (
    find?.comprehensive === true &&
    (find?.candidates?.length ?? 0) === 0 &&
    fable?.comprehensive === true &&
    (fable?.candidates?.length ?? 0) === 0 &&
    verify?.passed === true
  );
}

export function resolvedFocus(value: unknown): "quality" | "tests" {
  return value === "tests" ? "tests" : "quality";
}

export function runVerifyGate(root: string = ROOT): { passed: boolean; summary: string } {
  const cwd = resolve(root, ".smithers");
  const steps: Array<[string, string[]]> = [
    ["bun", ["lib/ddd/build.ts"]],
    ["pnpm", ["typecheck"]],
    ["bun", ["test", "./tests", "./ui", "./lib", "--timeout", "120000"]],
  ];
  for (const [cmd, args] of steps) {
    try {
      execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { passed: false, summary: `${cmd} ${args.join(" ")} failed: ${message.slice(0, 4000)}` };
    }
  }
  return { passed: true, summary: "build + typecheck + tests green" };
}

export default smithers((ctx) => {
  const focus = resolvedFocus(ctx.input.focus);
  const maxRounds = Number(ctx.input.maxRounds) >= 1 ? Number(ctx.input.maxRounds) : 1000;
  const SURFACE = `${FOCUS_BARS[focus]}\n${SHARED_SURFACE}`;

  return (
    <Workflow name="ddd-improve">
      <Loop id="improve-loop" until={improveComplete(ctx)} maxIterations={maxRounds} onMaxReached="return-last">
        <Sequence>
          <Task id="find" output={outputs.find} agent={codex} retries={1} timeoutMs={20 * 60 * 1000}>
            {`You are the ${focus} finder for the DDD surface. List the highest-value candidates (max 6 per round, most valuable first). Set comprehensive=true with ZERO candidates ONLY when the surface genuinely meets the bar; otherwise comprehensive=false. Do not write any files. Return only JSON matching the find schema. ${SURFACE}`}
          </Task>

          {/* claude-fable-5 second opinion: a cheap no-op while codex is still
              iterating; a real adversarial hunt once codex claims done. */}
          <Task
            id="second-opinion"
            output={outputs.fable}
            agent={fable}
            retries={1}
            timeoutMs={20 * 60 * 1000}
            dependsOn={["find"]}
            needs={{ find: "find" }}
            deps={{ find: outputs.find }}
          >
            {(deps: any) =>
              deps.find?.comprehensive === true && (deps.find?.candidates?.length ?? 0) === 0
                ? `Codex has declared the DDD ${focus} bar met. You are the adversarial second-opinion finder. Independently inspect the whole surface with fresh eyes and hunt for anything codex missed. Set comprehensive=true with ZERO candidates only if you genuinely find nothing worth adding; otherwise list candidates (max 6). Do not write files. Return only JSON matching the find schema. ${SURFACE}`
                : `Codex is still iterating (its finder has open candidates or comprehensive=false). Do nothing. Return only JSON: {"comprehensive": false, "candidates": [], "summary": "deferred until codex declares comprehensive"}.`
            }
          </Task>

          <Task
            id="implement"
            output={outputs.implement}
            agent={codex}
            retries={1}
            timeoutMs={60 * 60 * 1000}
            dependsOn={["second-opinion"]}
            needs={{ find: "find", fable: "second-opinion" }}
            deps={{ find: outputs.find, fable: outputs.fable }}
          >
            {(deps: any) => {
              const candidates = [...(deps.find?.candidates ?? []), ...(deps.fable?.candidates ?? [])];
              return candidates.length === 0
                ? `No candidates this round. Return JSON matching the implement schema with status "skipped".`
                : `Implement these candidates now. Verify each change as you go (run the gate commands; for tests, RUN each new test and fix failures — including real product bugs the tests expose; fix the product, never weaken a test). Return only JSON matching the implement schema.

Candidates:
${JSON.stringify(candidates, null, 2)}
${SURFACE}`;
            }}
          </Task>

          <Task id="verify" output={outputs.verify} dependsOn={["implement"]}>
            {async () => runVerifyGate()}
          </Task>
        </Sequence>
      </Loop>
    </Workflow>
  );
});
