// smithers-source: user
// smithers-display-name: Coverage Codex Swarm
// smithers-description: Run parallel Codex /goal workers in isolated worktrees to raise package test coverage to a target percentage.
// smithers-tags: coding, tests, coverage, codex, parallel
/** @jsxImportSource smithers-orchestrator */
import { join } from "node:path";
import { createSmithers, Parallel, Sequence, Task, Worktree } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";

const packageStats = [
  { path: "packages/db", lines: 83.57, functions: 81.1 },
  { path: "packages/server", lines: 56.79, functions: 72.06 },
  { path: "packages/gateway-react", lines: 91.67, functions: 87.75 },
  { path: "packages/time-travel", lines: 90.93, functions: 87.56 },
  { path: "packages/gateway-client", lines: 95.52, functions: 94.66 },
  { path: "packages/scheduler", lines: 86.92, functions: 94.79 },
  { path: "packages/driver", lines: 99.79, functions: 96.26 },
  { path: "packages/protocol", lines: 100, functions: 100 },
  { path: "packages/usage", lines: 87.43, functions: 94.23 },
] as const;

const inputSchema = z
  .object({
    coverageThreshold: z.number().min(0).max(100).optional(),
    n: z.number().min(0).max(100).optional(),
    maxConcurrency: z.number().int().min(1).max(8).default(4),
    packages: z.array(z.string()).optional(),
    packageInstructions: z.record(z.string(), z.string()).optional(),
    includeAlreadyCovered: z.boolean().default(false),
  })
  .superRefine((input, ctx) => {
    for (const requested of input.packages ?? []) {
      if (!packageStats.some((item) => item.path === requested)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["packages"], message: `Unknown package: ${requested}` });
      }
    }
  });

const coverageResultSchema = z.object({
  package: z.string(),
  targetPercent: z.number(),
  status: z.enum(["done", "partial", "blocked"]),
  summary: z.string(),
  filesChanged: z.array(z.string()).default([]),
  verificationEvidence: z.array(z.string()).default([]),
  finalLinesPercent: z.number().nullable().default(null),
  finalFunctionsPercent: z.number().nullable().default(null),
  blocker: z.string().nullable().default(null),
});

const { Workflow, smithers } = createSmithers({
  input: inputSchema,
  coverageResult: coverageResultSchema,
});

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function promptForCoverageTarget(
  item: (typeof packageStats)[number],
  targetPercent: number,
  extraInstructions?: string,
) {
  return `/goal Raise test coverage for ${item.path} to at least ${targetPercent}% lines and ${targetPercent}% functions.

Context:
- Current baseline from the operator: ${item.lines.toFixed(2)}% lines, ${item.functions.toFixed(2)}% functions.
- Target: >= ${targetPercent}% lines AND >= ${targetPercent}% functions for this package.
- You are running inside an isolated Smithers worktree for ${item.path}.
${extraInstructions ? `\nAdditional package-specific instructions:\n${extraInstructions}\n` : ""}

Rules:
- Focus on meaningful tests for existing behavior in ${item.path}. Avoid superficial tests that only execute code without assertions.
- Keep implementation changes minimal. Prefer tests over product code changes unless a real bug blocks testing.
- Do not modify unrelated packages except for narrowly required shared test helpers.
- Do not merge back to the base branch.

Verification commands:
- Measure this package while iterating: SMITHERS_COVERAGE_PACKAGES=${item.path} pnpm coverage
- Run its package test suite directly when useful: pnpm --filter ./${item.path} test
- Before finishing, run: SMITHERS_COVERAGE_PACKAGES=${item.path} pnpm coverage

Required output:
- status must be "done" only if the final package coverage is >= ${targetPercent}% lines and >= ${targetPercent}% functions.
- Put every command you ran and its result in verificationEvidence.
- Set finalLinesPercent and finalFunctionsPercent from the final coverage summary.
- If the target is unrealistic because generated/untestable code dominates the package, set status "blocked" and explain the concrete blocker.`;
}

export default smithers((ctx) => {
  const input = ctx.input;
  const targetPercent = input.coverageThreshold ?? input.n ?? 99;
  const maxConcurrency = typeof input.maxConcurrency === "number" ? input.maxConcurrency : 4;
  const includeAlreadyCovered = input.includeAlreadyCovered === true;
  const packageInstructions = input.packageInstructions ?? {};
  const requested = new Set(input.packages ?? []);
  const workItems = packageStats.filter((item) => {
    const selected = requested.size === 0 || requested.has(item.path);
    if (!selected) return false;
    if (includeAlreadyCovered) return true;
    return item.lines < targetPercent || item.functions < targetPercent;
  });
  const repoRoot = process.cwd();

  return (
    <Workflow name="coverage-codex-swarm">
      <Sequence>
        {workItems.length === 0 ? (
          <Task id="coverage:noop" output={coverageResultSchema}>
            {{
              package: "all-selected-packages",
              targetPercent,
              status: "done",
              summary: `No selected packages are below ${targetPercent}% lines/functions coverage.`,
              filesChanged: [],
              verificationEvidence: [],
              finalLinesPercent: null,
              finalFunctionsPercent: null,
              blocker: null,
            }}
          </Task>
        ) : (
          <Parallel maxConcurrency={maxConcurrency}>
            {workItems.map((item) => {
              const slug = slugify(item.path);
              return (
                <Worktree
                  key={item.path}
                  path={join(repoRoot, ".smithers", "workflows", ".worktrees", `coverage-${slug}`)}
                  branch={`coverage/${slug}-to-${targetPercent}`}
                  baseBranch="main"
                >
                  <Task
                    id={`coverage:${slug}`}
                    output={coverageResultSchema}
                    agent={agents.implement}
                    timeoutMs={90 * 60_000}
                    heartbeatTimeoutMs={10 * 60_000}
                    retries={1}
                    continueOnFail
                  >
                    {promptForCoverageTarget(item, targetPercent, packageInstructions[item.path])}
                  </Task>
                </Worktree>
              );
            })}
          </Parallel>
        )}
      </Sequence>
    </Workflow>
  );
});
