// Bench fixture agents for the kanban workflow benchmark.
//
// Copied into the sandbox repo as `.smithers/agents.ts`. Each agent is an
// in-process AgentLike whose generate():
//   1. sleeps a configurable per-kind delay (simulated LLM latency),
//   2. performs the REAL side effect the kanban pipeline needs (implement
//      commits a file in its worktree, merge really merges ticket branches),
//   3. returns a schema-valid fenced-JSON payload,
//   4. appends a timing record to the NDJSON file at $KANBAN_BENCH_LOG.
//
// Env contract (set by the bench runner):
//   KANBAN_BENCH_LOG            path to the agent-timing NDJSON file
//   KANBAN_BENCH_DELAYS         JSON {implement,validate,review,merge} ms
//   KANBAN_BENCH_FAIL_VALIDATE  comma-separated ticket slugs whose FIRST
//                               validation fails (forces a 2nd loop round)
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { AgentLike } from "smthrs";

type DelayTable = Partial<Record<"implement" | "validate" | "review" | "merge" | "other", number>>;

const delays: DelayTable = (() => {
  try {
    return JSON.parse(process.env.KANBAN_BENCH_DELAYS ?? "{}");
  } catch {
    return {};
  }
})();

const failFirstValidate = new Set(
  (process.env.KANBAN_BENCH_FAIL_VALIDATE ?? "").split(",").map((s) => s.trim()).filter(Boolean),
);

function logEvent(entry: Record<string, unknown>) {
  const file = process.env.KANBAN_BENCH_LOG;
  if (!file) return;
  try {
    appendFileSync(file, `${JSON.stringify(entry)}\n`);
  } catch {}
}

function git(args: string[], cwd: string) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type NodeKind = "implement" | "validate" | "review" | "merge" | "other";

function kindOf(nodeId: string): NodeKind {
  if (nodeId.endsWith(":implement")) return "implement";
  if (nodeId.endsWith(":validate")) return "validate";
  if (nodeId.includes(":review")) return "review";
  if (nodeId === "merge") return "merge";
  return "other";
}

class BenchAgent implements AgentLike {
  id: string;
  model: string;
  engine = "claude" as const;
  cliEngine = "claude" as const;
  supportsNativeStructuredOutput = false;

  constructor(id: string, model = "bench-model") {
    this.id = id;
    this.model = model;
  }

  async preflight() {}

  async generate(args: any = {}) {
    const nodeId: string = args?.taskContext?.nodeId ?? "";
    const iteration: number = args?.taskContext?.iteration ?? 0;
    const attempt: number = args?.taskContext?.attempt ?? 1;
    const rootDir: string = args?.rootDir ?? process.cwd();
    const kind = kindOf(nodeId);
    const delayMs = Number(delays[kind] ?? 0);
    const tStart = Date.now();
    if (delayMs > 0) await sleep(delayMs);

    let payload: Record<string, unknown>;
    switch (kind) {
      case "implement": {
        const slug = nodeId.slice(0, -":implement".length);
        const rel = join("bench-output", `${slug}.txt`);
        mkdirSync(join(rootDir, "bench-output"), { recursive: true });
        writeFileSync(join(rootDir, rel), `bench artifact for ${slug} iteration ${iteration}\n`);
        git(["add", rel], rootDir);
        git(["commit", "-m", `bench: ${slug} iteration ${iteration}`], rootDir);
        payload = { summary: `implemented ${slug}`, filesChanged: [rel], allTestsPassing: true };
        break;
      }
      case "validate": {
        const slug = nodeId.slice(0, -":validate".length);
        if (iteration === 0 && failFirstValidate.has(slug)) {
          payload = {
            summary: `validation failed for ${slug}`,
            allPassed: false,
            failingSummary: "bench-injected first-round failure: please re-implement",
          };
        } else {
          payload = { summary: `validated ${slug}`, allPassed: true, failingSummary: null };
        }
        break;
      }
      case "review": {
        payload = { reviewer: this.id, approved: true, feedback: "LGTM (bench)", issues: [] };
        break;
      }
      case "merge": {
        const branches = (git(["for-each-ref", "--format=%(refname:short)", "refs/heads/ticket/"], rootDir).stdout ?? "")
          .trim()
          .split("\n")
          .filter(Boolean);
        const merged: string[] = [];
        const conflicted: string[] = [];
        for (const branch of branches) {
          const ahead = ((git(["rev-list", "--count", `main..${branch}`], rootDir).stdout) ?? "0").trim();
          if (ahead === "" || ahead === "0") continue;
          const result = git(["merge", "--no-ff", "-m", `merge ${branch}`, branch], rootDir);
          if (result.status === 0) {
            merged.push(branch);
          } else {
            git(["merge", "--abort"], rootDir);
            conflicted.push(branch);
          }
        }
        payload = { merged, conflicted, summary: `merged ${merged.length}/${branches.length} ticket branches` };
        break;
      }
      default: {
        payload = {};
      }
    }

    const tEnd = Date.now();
    logEvent({ nodeId, iteration, attempt, agentId: this.id, kind, tStart, tEnd, delayMs, rootDir });
    const text = `\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`\n`;
    return {
      text,
      response: {
        modelId: this.model,
        messages: [{ role: "assistant", content: [{ type: "text", text }] }],
      },
    };
  }
}

export const providers = {
  implementA: new BenchAgent("bench-implement"),
  smartA: new BenchAgent("bench-smart"),
  reviewA: new BenchAgent("bench-review-1"),
  reviewB: new BenchAgent("bench-review-2"),
  reviewC: new BenchAgent("bench-review-3"),
} as const;

// Mirrors the real .smithers/agents.ts pool shape: `review` has THREE entries,
// which the kanban workflow fans out as three parallel reviewers per ticket.
// KANBAN_BENCH_REVIEWERS overrides the pool size (1-3) to measure the cost of
// the review fan-out.
const reviewerCount = Math.min(3, Math.max(1, Number(process.env.KANBAN_BENCH_REVIEWERS ?? 3) || 3));

export const agents = {
  cheapFast: [providers.smartA],
  smart: [providers.smartA],
  smartTool: [providers.smartA],
  planning: [providers.smartA],
  review: [providers.reviewA, providers.reviewB, providers.reviewC].slice(0, reviewerCount),
  implement: [providers.implementA],
} as const satisfies Record<string, AgentLike[]>;
