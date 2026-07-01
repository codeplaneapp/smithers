import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { GENERATED_SEEDED_FILES } from "../src/seeded-workflow-pack.generated.js";
import {
  createExecutableDir,
  createTempRepo,
  runSmithers,
  writeExecutable,
} from "../../../packages/smithers/tests/e2e-helpers.js";

const CLI_ENTRY = resolve(import.meta.dir, "../src/index.js");

const SEEDED_WORKFLOW_IDS = GENERATED_SEEDED_FILES
  .filter((file) => file.path.startsWith(".smithers/workflows/") && file.path.endsWith(".tsx"))
  .map((file) => file.path.split("/").pop().replace(/\.tsx$/, ""))
  .sort();

const AGENT_RESPONSE = JSON.stringify({
  greeting: "Hello, world.",
  summary: "mock agent completed the task",
  prompt: "hello",
  goal: "Complete the requested task.",
  reviewer: "mock-reviewer",
  approved: true,
  feedback: "looks good",
  issues: [],
  filesChanged: [],
  verificationEvidence: ["fake agent completed"],
  allTestsPassing: true,
  allPassed: true,
  failingSummary: null,
  steps: ["inspect", "implement", "verify"],
  tickets: [],
  workflowName: "mock-workflow",
  name: "mock",
  skillName: "mock-skill",
  targetRunId: "missing-run",
  mode: "single_task",
  modes: ["implementation"],
  durable: false,
  recommendedWorkflow: null,
  alternativeWorkflows: [],
  workflow: "implement",
  why: "mock",
  reason: "mock",
  needsDurable: false,
  durableRequired: false,
  humanApprovalRequired: false,
  commands: [],
  files: [],
  prompts: [],
  components: [],
  openQuestions: [],
  successCriteria: [],
  stages: [],
  loops: [],
  humanGates: [],
  inputs: [],
  outputs: [],
  agents: [],
  notes: "mock",
  trigger: "manual",
  purpose: "Create a small deterministic fixture.",
  whenToUse: "Use this fixture during seeded workflow smoke tests.",
  capabilities: ["respond with deterministic JSON"],
  frontmatter: {
    name: "mock-skill",
    description: "Use when a test needs a deterministic skill fixture.",
  },
  sections: [{ heading: "Procedure", purpose: "Explain the deterministic test procedure." }],
  supportingFiles: [],
  docsFragments: [],
  examples: [],
  graphShape: "Sequence with one task",
  tasks: [{ id: "output", purpose: "Return a deterministic result.", agent: "(none)", outputs: ["output"] }],
  skillPath: ".smithers/skills/mock/SKILL.md",
  artifactPath: ".smithers/artifacts/mock.md",
  criteria: ["The run completes."],
  gates: [{
    criterion: "The run completes.",
    verificationMethod: "schema",
    gateType: "blocking",
    checkedBy: "seeded smoke test",
    failureAction: "fail the run",
    evidenceRequired: ["finished status"],
    humanApprovalRequired: false,
  }],
  selectedRoute: "single_task",
  selectedSkills: [],
  selectedWorkflow: null,
  artifacts: [],
  done: true,
  fixes: [],
  question: "No blocking question remains.",
  recommendedAnswer: null,
  branch: null,
  resolved: true,
  questionsAsked: 1,
  sharedUnderstanding: "The smoke fixture can proceed.",
  repeatedPattern: "A deterministic seeded workflow smoke fixture.",
  reusableAsSkill: false,
  reusableAsWorkflow: false,
  memoryFacts: [],
  proposedSkill: null,
  proposedWorkflow: null,
  memoryToPersist: [],
  suiteName: "mock-suite",
  cases: [],
  caseCount: 0,
  runCommand: "smithers eval .smithers/evals/mock.jsonl",
  rootCauseHypothesis: "mock root cause",
  evidence: ["fake evidence"],
  confidence: "medium",
  recommendedAction: "retry",
  command: "smithers inspect missing-run",
  rationale: "The fake fixture recommends a harmless retry.",
  buckets: { healthy: [], stuck: [], blocked: [], failed: [], overBudget: [] },
  actions: [],
  health: "healthy",
  waitingOn: null,
  rootCause: "",
  recommendedActions: [],
  anySelfFixable: false,
  html: "<html><body>mock report</body></html>",
  title: "mock report",
  sectionCount: 1,
  slideCount: 1,
  path: ".smithers/artifacts/mock.html",
  bytes: 1,
  digest: "abc123",
  tier: "trivial",
  status: "delivered",
  route: "trivial",
  reportPath: null,
  branch: null,
  prUrl: null,
  ticketCount: 0,
  mustFixCount: 0,
  implRunId: null,
});

const WORKFLOW_INPUTS = {
  "create-skill": { prompt: "Create a tiny test skill.", review: false, name: "mock-skill" },
  "create-workflow": { prompt: "Create a tiny test workflow.", review: false, name: "mock-workflow" },
  "context-engineer": { prompt: "Plan a tiny safe change.", review: false },
  monitor: { targetRunId: "missing-run", autofix: false, requireApproval: false },
  "report-slideshow": { targetRunId: "missing-run", title: "Missing run report" },
  smithering: {
    prompt: "Make a tiny harmless change.",
    route: "trivial",
    review: false,
    poc: false,
    smokeTest: false,
  },
  "triage-run": { targetRunId: "missing-run" },
};

function workflowInput(id) {
  return WORKFLOW_INPUTS[id] ?? { prompt: "hello" };
}

function writeBunxShim(binDir) {
  writeExecutable(binDir, "bunx", [
    "#!/usr/bin/env bun",
    'import { spawnSync } from "node:child_process";',
    `const cliEntry = ${JSON.stringify(CLI_ENTRY)};`,
    "const args = process.argv.slice(2);",
    'if (args[0] !== "smithers-orchestrator") {',
    '  process.stderr.write(`unsupported bunx command in test fixture: ${args.join(" ")}\\n`);',
    "  process.exit(127);",
    "}",
    'const child = spawnSync(process.execPath, ["run", cliEntry, ...args.slice(1)], {',
    '  cwd: process.cwd(),',
    '  env: process.env,',
    '  stdio: "inherit",',
    "});",
    "process.exit(child.status ?? (child.signal ? 1 : 0));",
    "",
  ].join("\n"));
}

function writeFakeAgentBinaries(binDir) {
  const fixtureScript = [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    "function writeFixtureFiles() {",
    "  const root = process.cwd();",
    '  const workflowDir = path.join(root, ".smithers", "workflows");',
    '  const skillDir = path.join(root, ".smithers", "skills", "mock-skill");',
    "  fs.mkdirSync(workflowDir, { recursive: true });",
    "  fs.mkdirSync(skillDir, { recursive: true });",
    '  fs.writeFileSync(path.join(workflowDir, "mock-workflow.tsx"), [',
    '    "// smithers-source: generated",',
    '    "// smithers-metadata-version: 1",',
    '    "// smithers-display-name: Mock Workflow",',
    '    "/** @jsxImportSource smithers-orchestrator */",',
    '    "import { createSmithers } from \\"smithers-orchestrator\\";",',
    '    "import { z } from \\"zod/v4\\";",',
    '    "const { Workflow, Task, smithers, outputs } = createSmithers({ output: z.object({ summary: z.string() }) });",',
    '    "export default smithers(() => (",',
    '    "  <Workflow name=\\"mock-workflow\\">",',
    '    "    <Task id=\\"output\\" output={outputs.output}>{() => ({ summary: \\"mock workflow ok\\" })}</Task>",',
    '    "  </Workflow>",',
    '    "));",',
    '    "",',
    '  ].join("\\n"), "utf8");',
    '  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\\nname: mock-skill\\ndescription: Test fixture skill.\\n---\\n\\n# Mock Skill\\n", "utf8");',
    "}",
    "writeFixtureFiles();",
  ].join("\n");
  const responseLiteral = JSON.stringify(AGENT_RESPONSE);
  writeExecutable(binDir, "claude", [
    "#!/usr/bin/env bun",
    fixtureScript,
    "const args = process.argv.slice(2);",
    'if (args.join(" ") === "auth status") {',
    '  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }) + "\\n");',
    "  process.exit(0);",
    "}",
    `const payload = process.env.SMITHERS_FAKE_AGENT_RESPONSE ?? ${responseLiteral};`,
    'process.stdout.write(JSON.stringify({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "```json\\n" + payload + "\\n```\\n" }] } }) + "\\n");',
    "",
  ].join("\n"));
  writeExecutable(binDir, "codex", [
    "#!/usr/bin/env bun",
    fixtureScript,
    `const payload = process.env.SMITHERS_FAKE_AGENT_RESPONSE ?? ${responseLiteral};`,
    "const args = process.argv.slice(2);",
    'const outputIndex = args.indexOf("--output-last-message");',
    "if (outputIndex >= 0 && args[outputIndex + 1]) {",
    '  fs.writeFileSync(args[outputIndex + 1], "```json\\n" + payload + "\\n```\\n", "utf8");',
    "}",
    'process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\\n");',
    "",
  ].join("\n"));
  writeExecutable(binDir, "agy", [
    "#!/usr/bin/env bun",
    fixtureScript,
    `const payload = process.env.SMITHERS_FAKE_AGENT_RESPONSE ?? ${responseLiteral};`,
    'process.stdout.write(payload + "\\n");',
    "",
  ].join("\n"));
}

function initWorkflowPack() {
  const repo = createTempRepo();
  const binDir = createExecutableDir();
  writeFakeAgentBinaries(binDir);
  writeBunxShim(binDir);
  repo.write(".claude/.credentials.json", "{}\n");
  repo.write(".codex/auth.json", JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: { access_token: "fake-access-token", account_id: "acct_test" },
  }) + "\n");
  repo.write(".gemini/antigravity-cli/settings.json", "{}\n");
  const env = {
    HOME: repo.dir,
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    ANTHROPIC_API_KEY: "",
    OPENAI_API_KEY: "",
    GEMINI_API_KEY: "",
    GOOGLE_API_KEY: "",
    SMITHERS_FAKE_AGENT_RESPONSE: AGENT_RESPONSE,
  };
  const init = runSmithers(["init", "--no-install"], { cwd: repo.dir, format: "json", env });
  expect(init.exitCode).toBe(0);
  return { repo, env };
}

test("every generated init-pack workflow starts and reaches a valid smoke state with fake agents", () => {
  expect(SEEDED_WORKFLOW_IDS.length).toBeGreaterThan(10);
});

function isValidSmokeOutcome(id, status, exitCode) {
  if (exitCode === 0 && status === "finished") return true;
  // This onboarding tutorial is intentionally interactive: the smoke run is
  // healthy when it reaches the human pick step after rendering its prompt.
  return id === "make-workflow-tutorial" && exitCode === 3 && status === "waiting-approval";
}

for (const id of SEEDED_WORKFLOW_IDS) {
  test(`seeded workflow ${id} runs with fake agents`, () => {
    const { repo, env } = initWorkflowPack();
    const result = runSmithers(
      ["workflow", "run", id, "--input", JSON.stringify(workflowInput(id))],
      { cwd: repo.dir, format: "json", env, timeoutMs: 60_000 },
    );
    const status = result.json?.status;
    if (!isValidSmokeOutcome(id, status, result.exitCode)) {
      const detail = `${result.stdout}\n${result.stderr}`
        .split("\n")
        .filter((line) => /Run failed|failed|error|INVALID|ENOENT|Cannot|unsupported/i.test(line))
        .slice(-4)
        .join(" ")
        .slice(0, 800);
      throw new Error(`${id} exited ${result.exitCode} with status ${String(status)}: ${detail}`);
    }
  }, 90_000);
}
