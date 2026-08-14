// Builds a hermetic sandbox git repo for the kanban workflow benchmark.
//
// Layout mirrors what `smithers init` + real usage produces, but with the
// generated `.smithers/agents.ts` swapped for deterministic bench agents
// (fixtures/agents.bench.ts). The workflow, ValidationLoop, Review, and
// prompt files are byte-copies of the real `.smithers` pack so the benchmark
// exercises the exact production node graph.
//
// A local bare `origin` remote is wired up so the engine's per-task
// `git fetch origin` + rebase path actually executes (it no-ops fast when a
// repo has no remote, which would understate per-task overhead).
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

export type KanbanBenchSandbox = {
  root: string;
  ticketSlugs: string[];
};

export type KanbanBenchSandboxOptions = {
  root: string;
  tickets: number;
};

function git(args: string[], cwd: string) {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

const SANDBOX_TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      lib: ["ESNext"],
      target: "ESNext",
      module: "ESNext",
      jsx: "react-jsx",
      jsxImportSource: "smthrs",
      moduleResolution: "bundler",
      allowImportingTsExtensions: true,
      noEmit: true,
      baseUrl: ".",
      paths: { "~/*": ["./*"] },
    },
  },
  null,
  2,
);

// Review.tsx imports `synthesizer` from ./roles; the real roles.ts constructs
// live agent CLIs at module load. The kanban workflow never uses the
// synthesizer (it uses plain <Review>, not <ReviewPanel>), so stub it.
const ROLES_STUB = `// bench stub: kanban uses plain <Review>; the synthesizer is never invoked.
import { providers } from "../agents";
export const synthesizer = [providers.smartA];
`;

function ticketBody(n: number): string {
  const id = String(n).padStart(2, "0");
  return [
    `# Ticket t${id}: add bench note ${id}`,
    "",
    "## Goal",
    `Create the file \`bench-output/bench__t${id}.txt\` containing a short note.`,
    "",
    "## Acceptance criteria",
    `- The file exists on this ticket's branch.`,
    "- The change is committed with a conventional commit message.",
    "",
    "## Notes",
    "This is a synthetic benchmark ticket. The work is intentionally trivial so",
    "the run measures orchestration cost, not agent thinking time.",
    "",
  ].join("\n");
}

export function createKanbanBenchSandbox(options: KanbanBenchSandboxOptions): KanbanBenchSandbox {
  const root = options.root;
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });

  // Module resolution: reuse the repo's node_modules (workspace links resolve
  // smthrs to packages/smithers, same code the CLI runs).
  symlinkSync(join(repoRoot, "node_modules"), join(root, "node_modules"), "dir");
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "kanban-bench-sandbox", private: true, type: "module" })}\n`);
  writeFileSync(
    join(root, ".gitignore"),
    ["node_modules/", ".worktrees/", "smithers.db*", ".smithers/executions/", ".smithers/workflows/*.log", "bench-agent-log.ndjson", ""].join("\n"),
  );

  const dotSmithers = join(root, ".smithers");
  mkdirSync(join(dotSmithers, "workflows"), { recursive: true });
  mkdirSync(join(dotSmithers, "components"), { recursive: true });
  mkdirSync(join(dotSmithers, "prompts"), { recursive: true });
  mkdirSync(join(dotSmithers, "ui"), { recursive: true });
  mkdirSync(join(dotSmithers, "tickets", "bench"), { recursive: true });

  writeFileSync(join(dotSmithers, "tsconfig.json"), `${SANDBOX_TSCONFIG}\n`);
  cpSync(resolve(repoRoot, ".smithers/workflows/kanban.tsx"), join(dotSmithers, "workflows/kanban.tsx"));
  cpSync(resolve(repoRoot, ".smithers/components/ValidationLoop.tsx"), join(dotSmithers, "components/ValidationLoop.tsx"));
  cpSync(resolve(repoRoot, ".smithers/components/Review.tsx"), join(dotSmithers, "components/Review.tsx"));
  cpSync(resolve(repoRoot, ".smithers/ui/kanban.tsx"), join(dotSmithers, "ui/kanban.tsx"));
  for (const prompt of ["implement.mdx", "validate.mdx", "review.mdx", "merge-tickets.mdx"]) {
    cpSync(resolve(repoRoot, `.smithers/prompts/${prompt}`), join(dotSmithers, "prompts", prompt));
  }
  writeFileSync(join(dotSmithers, "components/roles.ts"), ROLES_STUB);
  writeFileSync(join(dotSmithers, "agents.ts"), readFileSync(join(here, "fixtures/agents.bench.ts"), "utf8"));

  const ticketSlugs: string[] = [];
  for (let n = 1; n <= options.tickets; n += 1) {
    const id = String(n).padStart(2, "0");
    writeFileSync(join(dotSmithers, "tickets", "bench", `t${id}.md`), ticketBody(n));
    ticketSlugs.push(`bench__t${id}`);
  }

  writeFileSync(join(root, "README.md"), "# kanban-bench sandbox\n\nSynthetic repo for benchmarking the kanban workflow.\n");

  git(["init", "-b", "main"], root);
  git(["config", "user.email", "bench@smithers.sh"], root);
  git(["config", "user.name", "Kanban Bench"], root);
  git(["add", "."], root);
  git(["commit", "-m", "seed kanban bench sandbox"], root);

  // Local bare origin so per-task `git fetch origin` / rebase actually runs.
  const originDir = `${root}-origin.git`;
  rmSync(originDir, { recursive: true, force: true });
  git(["clone", "--bare", root, originDir], dirname(root));
  git(["remote", "add", "origin", originDir], root);
  git(["fetch", "origin"], root);

  return { root, ticketSlugs };
}
