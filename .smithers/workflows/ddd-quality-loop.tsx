// smithers-display-name: DDD Quality Loop
// smithers-description: Loop codex (assess + fix) then claude-fable-5 (adversarial polish) over the docs-driven-development app quality — UI formatting, CSS, code quality, missing features — until both declare it excellent.
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

const codex = providers.codex;
const fable = providers.claude; // claude-fable-5

const inputSchema = z.object({
  maxRounds: z.preprocess((v) => v ?? undefined, z.number().int().min(1).max(1000).default(1000)),
});

const assessSchema = z.object({
  excellent: z.boolean().default(false),
  issues: z.array(z.object({
    id: z.string(),
    title: z.string(),
    kind: z.enum(["ui-format", "css", "code-quality", "missing-feature", "bug"]),
    files: z.array(z.string()).default([]),
    detail: z.string().default(""),
  })).default([]),
  summary: z.string().default(""),
});

const fixSchema = z.object({
  status: z.enum(["done", "partial", "blocked", "skipped"]).default("skipped"),
  filesChanged: z.array(z.string()).default([]),
  fixed: z.array(z.string()).default([]),
  summary: z.string().default(""),
});

const fableSchema = z.object({
  satisfied: z.boolean().default(false),
  filesChanged: z.array(z.string()).default([]),
  improvements: z.array(z.string()).default([]),
  summary: z.string().default(""),
});

const verifySchema = z.object({
  passed: z.boolean().default(false),
  summary: z.string().default(""),
});

const { Workflow, smithers } = createSmithers({
  input: inputSchema,
  assess: assessSchema,
  fix: fixSchema,
  fable: fableSchema,
  verify: verifySchema,
});

const SURFACE = `
Improve the docs-driven-development (DDD) app in this repo (root: ${ROOT}) as a PRODUCT:
- UI: .smithers/ui/docs-driven-development.tsx + ddd-shared.tsx + ddd-{Specs,Features,Audit,Live,Tickets}Tab.tsx (rendered via smithers ui / gateway-react; Milkdown Crepe editor). Quality bar: everything that should be formatted IS formatted (dates, counts, statuses, long text truncation), consistent spacing/typography, polished CSS in light AND dark, empty/loading/error states everywhere, no raw JSON dumps shown to users, keyboard/hover affordances, no layout jank.
- Scripts: .smithers/lib/ddd/*.ts — code quality, readable errors, deterministic output.
- Spec content: .smithers/spec/content/overview.md quality prose; derived docs formatting from generateSpecDocs.ts.
- Missing features worth adding (small, high-value): e.g. search/filter in Features and Tickets tabs, unsaved-changes indicator in Docs tab, run status auto-refresh polish, better ticket detail view.

Hard rules:
- Preview your work: run "cd ${ROOT}/.smithers && bun lib/ddd/build.ts" then check the UI renders by loading http://127.0.0.1:7331/workflows/docs-driven-development (a gateway is usually running; if not, skip browser check).
- A PARALLEL test-coverage workflow is writing tests for this same surface right now. Keep every existing test green (cd .smithers && bun test ./tests ./ui ./lib). If a test conflicts with a genuine improvement, prefer fixing the product AND updating the test honestly.
- NEVER edit .smithers/workflows/ddd-quality-loop.tsx or .smithers/workflows/ddd-test-coverage.tsx (running workflows) — record such findings in your summary instead. Editing .smithers/workflows/docs-driven-development.tsx is allowed only for real bugs.
- Keep pnpm -C .smithers typecheck and pnpm -C .smithers lint green. No mocks anywhere. No em-dashes in user-facing prose.
- Commit nothing.
`;

function qualityComplete(ctx: any): boolean {
  const assess = ctx.outputMaybe("assess", { nodeId: "assess" });
  const fable = ctx.outputMaybe("fable", { nodeId: "fable-pass" });
  const verify = ctx.outputMaybe("verify", { nodeId: "verify" });
  return (
    assess?.excellent === true &&
    (assess?.issues?.length ?? 0) === 0 &&
    fable?.satisfied === true &&
    verify?.passed === true
  );
}

export default smithers((ctx) => {
  const maxRounds = Number(ctx.input.maxRounds) >= 1 ? Number(ctx.input.maxRounds) : 1000;
  return (
    <Workflow name="ddd-quality-loop">
      <Loop id="quality-loop" until={qualityComplete(ctx)} maxIterations={maxRounds} onMaxReached="return-last">
        <Sequence>
          <Task id="assess" output="assess" agent={codex} retries={1} timeoutMs={20 * 60 * 1000}>
            {`You are the quality assessor. Look at the DDD app the way a picky user and a picky staff engineer would: open every UI file, read the CSS, read the scripts, imagine every tab in the browser. List the highest-impact quality issues (max 5 per round, worst first): unformatted UI that should be formatted, bad CSS, bad code, missing small features, bugs. Set excellent=true with ZERO issues only when the app genuinely looks and reads like a polished product. Do not write files. Return only JSON matching the assess schema. ${SURFACE}`}
          </Task>
          <Task
            id="fix"
            output="fix"
            agent={codex}
            retries={1}
            timeoutMs={60 * 60 * 1000}
            dependsOn={["assess"]}
            deps={{ assess: "assess" }}
          >
            {(deps: any) =>
              (deps.assess?.issues?.length ?? 0) === 0
                ? `No issues this round. Return JSON matching the fix schema with status "skipped".`
                : `Fix these quality issues now. Verify each fix (build script, typecheck, lint, tests still green). Return only JSON matching the fix schema.

Issues:
${JSON.stringify(deps.assess.issues, null, 2)}
${SURFACE}`
            }
          </Task>
          {/* claude-fable-5 pass: no-op while codex is still iterating; once codex
              declares excellent, fable hunts for what codex missed and fixes it
              ITSELF (it implements, not just reviews). */}
          <Task
            id="fable-pass"
            output="fable"
            agent={fable}
            retries={1}
            timeoutMs={60 * 60 * 1000}
            dependsOn={["fix"]}
            deps={{ assess: "assess" }}
          >
            {(deps: any) =>
              deps.assess?.excellent === true && (deps.assess?.issues?.length ?? 0) === 0
                ? `Codex has declared the DDD app quality excellent. You are the adversarial second-opinion improver. Independently inspect the whole surface with fresh eyes; find anything unpolished, badly formatted, ugly, confusing, or missing — and FIX it yourself, verifying as you go. Set satisfied=true only if you genuinely found nothing (or only what you already fixed this pass and a re-look would find nothing). Return only JSON matching the fable schema. ${SURFACE}`
                : `Codex is still iterating (open issues or excellent=false). Do nothing. Return only JSON: {"satisfied": false, "filesChanged": [], "improvements": [], "summary": "deferred until codex declares excellent"}.`
            }
          </Task>
          <Task id="verify" output="verify" dependsOn={["fable-pass"]}>
            {async () => {
              const cwd = resolve(ROOT, ".smithers");
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
            }}
          </Task>
        </Sequence>
      </Loop>
    </Workflow>
  );
});
