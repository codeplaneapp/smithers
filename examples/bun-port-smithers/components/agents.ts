import { ClaudeCodeAgent, PiAgent } from "smithers-orchestrator";

type AgentArgs = {
  prompt?: string;
  outputSchema?: unknown;
};

type AgentResult = {
  text: string;
  output: Record<string, unknown>;
};

type LocalAgent = {
  id: string;
  generate(args?: AgentArgs): Promise<AgentResult>;
};

const useRealAgents = process.env.BUN_PORT_SMITHERS_REAL_AGENTS === "1";

function readTag(prompt: string, name: string, fallback = ""): string {
  const match = prompt.match(new RegExp(`${name}:\\s*([\\s\\S]*?)(?=(?:\\s+|)[A-Z_]+:|$)`));
  return match?.[1]?.trim() ?? fallback;
}

function dryOutput(kind: string, prompt: string): Record<string, unknown> {
  const zig = readTag(prompt, "ZIG", "src/example/example.zig");
  const rs = readTag(prompt, "RS", zig.replace(/\.zig$/, ".rs"));
  const crate = readTag(prompt, "CRATE", "example");
  const targetId = readTag(prompt, "TARGET", "target");
  const subject = readTag(prompt, "SUBJECT", targetId);
  const areaId = readTag(prompt, "AREA", "area");
  const branch = readTag(prompt, "BRANCH", `bun-port/${areaId}`);
  const probeId = readTag(prompt, "PROBE", "probe");
  const command = readTag(prompt, "COMMAND", "--help");
  const failureKey = readTag(prompt, "FAILURE", "failure");
  const sweepId = readTag(prompt, "SWEEP", "sweep");
  const key = readTag(prompt, "FIELD_KEY", `${zig}|Example|ptr`);
  const voter = readTag(prompt, "VOTER", "dry");
  const tier = Number(readTag(prompt, "TIER", "0"));

  switch (kind) {
    case "lifetime-classify":
      return {
        file: zig,
        crate,
        fields: [{
          struct: "Example",
          field: "ptr",
          zigType: "?*Thing",
          class: "UNKNOWN",
          rustType: "Option<NonNull<Thing>>",
          evidence: `${zig}:1 dry-run fixture`,
          confidence: "low",
        }],
      };
    case "lifetime-verify":
      return { key, voter, refuted: false, correctClass: "UNKNOWN", reason: "dry-run accepted" };
    case "phase-a-implement":
      return { zig, rs, status: "drafted", confidence: "medium", todos: 0, rsLoc: 12, note: "dry-run draft" };
    case "phase-a-verify":
      return { subject: rs, reviewer: "phase-a-dry-reviewer", approved: true, ok: true, issues: [], feedback: "dry-run approved" };
    case "phase-a-fix":
      return { zig, rs, applied: 0, remaining: 0, note: "no dry-run fixes required" };
    case "crate-check":
      return {
        crate,
        tier: Number.isFinite(tier) ? tier : 0,
        compiles: true,
        errorCount: 0,
        rounds: 1,
        gatedModules: [],
        blockedOn: [],
        notes: "dry-run cargo check green",
      };
    case "proper-port":
      return { targetId, status: "patched", filesChanged: [readTag(prompt, "FILE", "src/example.rs")], summary: "dry-run patch" };
    case "spec-review":
      return { targetId, reviewer: voter, approved: true, issues: [], feedback: "dry-run approved" };
    case "spec-decision":
      return { targetId, approved: true, approvals: 2, rejections: 0, issues: [], feedback: "dry-run consensus approved" };
    case "build":
      return { ok: true, command: "cargo build -p bun_bin", summary: "dry-run build green" };
    case "probe":
      return {
        probeId,
        command,
        passed: true,
        panicLocation: null,
        assertion: null,
        signal: null,
        durationMs: 1,
        output: "dry-run probe passed",
      };
    case "failure-fix":
      return { failureKey, status: "fixed", filesChanged: [], summary: "dry-run failure fix" };
    case "test-area":
      return {
        areaId,
        pass: 1,
        fail: 0,
        total: 1,
        allPass: true,
        bughuntBugs: 0,
        commits: [],
        branch,
        notes: "dry-run area green",
      };
    case "merge":
      return { id: subject, picked: 0, conflicts: 0, notes: "dry-run merge" };
    case "sweep":
      return { sweepId, kind: readTag(prompt, "KIND", "sweep"), candidates: 1, fixed: 1, skipped: 0, summary: "dry-run sweep" };
    default:
      return { subject, reviewer: "dry", approved: true, ok: true, issues: [], feedback: "dry-run approved" };
  }
}

function makeDryAgent(kind: string): LocalAgent {
  return {
    id: `bun-port-dry:${kind}`,
    async generate(args?: AgentArgs): Promise<AgentResult> {
      const prompt = args?.prompt ?? "";
      const output = dryOutput(kind, prompt);
      return {
        text: JSON.stringify(output),
        output,
      };
    },
  };
}

function writerAgent(repo: string, kind = "phase-a-implement"): any {
  if (!useRealAgents) return makeDryAgent(kind);
  return new ClaudeCodeAgent({
    cwd: repo,
    model: process.env.BUN_PORT_WRITER_MODEL ?? "claude-sonnet-4-6",
    permissionMode: "acceptEdits",
    allowedTools: process.env.BUN_PORT_WRITER_ALLOWED_TOOLS?.split(",") ?? [
      "Read",
      "Grep",
      "Glob",
      "Write",
      "Edit",
      "MultiEdit",
      "Bash(cargo check:*)",
      "Bash(cargo build:*)",
      "Bash(cargo test:*)",
      "Bash(bun test:*)",
      "Bash(git status:*)",
      "Bash(git diff:*)",
      "Bash(git add:*)",
      "Bash(git commit:*)",
      "Bash(git cherry-pick:*)",
      "Bash(rg:*)",
      "Bash(sed:*)",
    ],
    disallowedTools: ["WebFetch", "WebSearch"],
    timeoutMs: 30 * 60 * 1000,
  });
}

function reviewerAgent(repo: string, kind = "phase-a-verify"): any {
  if (!useRealAgents) return makeDryAgent(kind);
  return new PiAgent({
    cwd: repo,
    provider: process.env.BUN_PORT_REVIEW_PROVIDER ?? "openai-codex",
    model: process.env.BUN_PORT_REVIEW_MODEL ?? "gpt-5.3-codex",
    mode: "rpc",
    thinking: "high",
    tools: ["read", "grep", "bash"],
  });
}

export function agentsForRepo(repo: string) {
  return {
    lifetimeClassifier: writerAgent(repo, "lifetime-classify"),
    lifetimeVerifier: reviewerAgent(repo, "lifetime-verify"),
    phaseAImplementer: writerAgent(repo, "phase-a-implement"),
    phaseAVerifier: reviewerAgent(repo, "phase-a-verify"),
    phaseAFixer: writerAgent(repo, "phase-a-fix"),
    crateChecker: writerAgent(repo, "crate-check"),
    properPorter: writerAgent(repo, "proper-port"),
    specReviewer: reviewerAgent(repo, "spec-review"),
    specDecider: reviewerAgent(repo, "spec-decision"),
    builder: writerAgent(repo, "build"),
    prober: writerAgent(repo, "probe"),
    failureFixer: writerAgent(repo, "failure-fix"),
    testAreaWorker: writerAgent(repo, "test-area"),
    mergeAgent: writerAgent(repo, "merge"),
    sweepAgent: writerAgent(repo, "sweep"),
    judge: reviewerAgent(repo, "judge"),
  };
}
