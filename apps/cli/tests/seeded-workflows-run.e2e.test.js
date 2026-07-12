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

const SMOKE_COMMAND_TIMEOUT_MS = 120_000;
const SMOKE_TEST_TIMEOUT_MS = 180_000;

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
  skillPath: ".smithers/skills/mock-workflow.md",
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
  rootCause: "The smoke fixture uses deterministic fake run evidence.",
  failureClass: "unknown",
  evidence: ["fake evidence"],
  confidence: "medium",
  suggestion: "retry",
  suggestionDetail: "Retry the failed task in the deterministic smoke fixture.",
  recommendedAction: "retry",
  command: "smithers inspect missing-run",
  bugTitle: "",
  bugBody: "",
  rationale: "The fake fixture recommends a harmless retry.",
  buckets: { healthy: [], stuck: [], blocked: [], failed: [], overBudget: [] },
  actions: [],
  health: "healthy",
  waitingOn: null,
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
  "post-failure": { targetRunId: "missing-run" },
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
    'let stdin = ""; try { stdin = fs.readFileSync(0, "utf8"); } catch {}',
    'const invocation = (process.argv.slice(2).join(" ") + "\\n" + stdin).toLowerCase();',
    "function writeFixtureFiles() {",
    "  const root = process.cwd();",
    '  const workflowDir = path.join(root, ".smithers", "workflows");',
    "  fs.mkdirSync(workflowDir, { recursive: true });",
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
    "}",
    "function writeSkillFixture() {",
    "  const root = process.cwd();",
    '  const skillsDir = path.join(root, ".smithers", "skills");',
    "  fs.mkdirSync(skillsDir, { recursive: true });",
    '  const mode = process.env.SMITHERS_TEST_SKILL_MODE || "positive";',
    '  const attemptsPath = path.join(root, ".smithers", "test-document-attempts");',
    '  const attempts = Number(fs.existsSync(attemptsPath) ? fs.readFileSync(attemptsPath, "utf8") : "0") + 1;',
    '  fs.writeFileSync(attemptsPath, String(attempts), "utf8");',
    '  if (mode === "missing") return;',
    '  if (mode === "wrong-path") { fs.writeFileSync(path.join(skillsDir, "wrong.md"), "---\\nname: mock-workflow\\nworkflow: mock-workflow\\n---\\nwrong path\\n", "utf8"); return; }',
    '  if (mode === "malformed" || (mode === "retry" && attempts === 1)) { fs.writeFileSync(path.join(skillsDir, "mock-workflow.md"), "---\\nname: [unterminated\\nworkflow: mock-workflow\\n---\\n", "utf8"); return; }',
    '  if (mode === "mismatched") { fs.writeFileSync(path.join(skillsDir, "mock-workflow.md"), "---\\nname: other-workflow\\nworkflow: mock-workflow\\n---\\n", "utf8"); return; }',
    '  fs.writeFileSync(path.join(skillsDir, "mock-workflow.md"), "---\\nname: mock-workflow\\ndescription: Test fixture skill.\\nworkflow: mock-workflow\\n---\\n\\n# Mock Workflow\\n", "utf8");',
    "}",
    'if (invocation.includes("scaffold")) writeFixtureFiles();',
    'if (invocation.includes("document")) writeSkillFixture();',
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
    `let payload = process.env.SMITHERS_FAKE_AGENT_RESPONSE ?? ${responseLiteral};`,
    'if (invocation.includes("document") && process.env.SMITHERS_TEST_SKILL_MODE === "wrong-path") { const parsed = JSON.parse(payload); parsed.skillPath = ".smithers/skills/wrong.md"; payload = JSON.stringify(parsed); }',
    'process.stdout.write(JSON.stringify({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "```json\\n" + payload + "\\n```\\n" }] } }) + "\\n");',
    "",
  ].join("\n"));
  writeExecutable(binDir, "codex", [
    "#!/usr/bin/env bun",
    fixtureScript,
    `let payload = process.env.SMITHERS_FAKE_AGENT_RESPONSE ?? ${responseLiteral};`,
    'if (invocation.includes("document") && process.env.SMITHERS_TEST_SKILL_MODE === "wrong-path") { const parsed = JSON.parse(payload); parsed.skillPath = ".smithers/skills/wrong.md"; payload = JSON.stringify(parsed); }',
    "const args = process.argv.slice(2);",
    'const outputIndex = args.indexOf("--output-last-message");',
    "if (outputIndex >= 0 && args[outputIndex + 1]) {",
    '  fs.writeFileSync(args[outputIndex + 1], payload + "\\n", "utf8");',
    "}",
    'process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\\n");',
    "",
  ].join("\n"));
  writeExecutable(binDir, "agy", [
    "#!/usr/bin/env bun",
    fixtureScript,
    `let payload = process.env.SMITHERS_FAKE_AGENT_RESPONSE ?? ${responseLiteral};`,
    'if (invocation.includes("document") && process.env.SMITHERS_TEST_SKILL_MODE === "wrong-path") { const parsed = JSON.parse(payload); parsed.skillPath = ".smithers/skills/wrong.md"; payload = JSON.stringify(parsed); }',
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
  const init = runSmithers(["init", "--no-install"], {
    cwd: repo.dir,
    format: "json",
    env,
    timeoutMs: SMOKE_COMMAND_TIMEOUT_MS,
  });
  expect(init.exitCode).toBe(0);
  return { repo, env };
}

test("every generated init-pack workflow starts and reaches a valid smoke state with fake agents", () => {
  expect(SEEDED_WORKFLOW_IDS).toEqual([
    "create-skill", "create-workflow", "docs-driven-development", "eval-suite-run", "init", "post-failure", "upgrade",
  ]);
});

function isValidSmokeOutcome(id, status, exitCode) {
  if (exitCode === 0 && status === "finished") return true;
  // These workflows are intentionally interactive: the smoke run is healthy
  // when it reaches its first durable human gate (the tutorial's pick step,
  // delegation-chain's refined-prompt approval).
  const interactive = id === "make-workflow-tutorial" || id === "delegation-chain";
  return interactive && exitCode === 3 && status === "waiting-approval";
}

for (const id of SEEDED_WORKFLOW_IDS) {
  if (id === "create-workflow") continue;
  // eval-suite-run requires a pre-saved suite (a real `_smithers_eval_suites`
  // row) to do anything meaningful — this generic single-command fake-agent
  // smoke harness has no way to seed one. It gets its own dedicated e2e
  // coverage instead: apps/cli/tests/eval-suite-run.e2e.test.js.
  if (id === "eval-suite-run") continue;
  if (id === "docs-driven-development") {
    test(`seeded workflow ${id} runs with fake agents and writes spec artifacts`, () => {
      const { repo, env } = initWorkflowPack();
      const result = runSmithers(
        ["workflow", "run", id, "--input", JSON.stringify({ runImplementation: false, maxRounds: 1, maxAgents: 1 })],
        { cwd: repo.dir, format: "json", env, timeoutMs: SMOKE_COMMAND_TIMEOUT_MS },
      );
      expect(result.exitCode).toBe(0);
      expect(result.json?.status).toBe("finished");
      expect(repo.exists(".smithers/spec/features.json")).toBe(true);
      expect(repo.exists(".smithers/spec/content/overview.md")).toBe(true);
      expect(repo.exists(".smithers/docs-driven-development/bootstrap-latest.json")).toBe(true);
    }, SMOKE_TEST_TIMEOUT_MS);
    continue;
  }
  test(`seeded workflow ${id} runs with fake agents`, () => {
    const { repo, env } = initWorkflowPack();
    const result = runSmithers(
      ["workflow", "run", id, "--input", JSON.stringify(workflowInput(id))],
      { cwd: repo.dir, format: "json", env, timeoutMs: SMOKE_COMMAND_TIMEOUT_MS },
    );
    const status = result.json?.status;
    if (!isValidSmokeOutcome(id, status, result.exitCode)) {
      const structuredDetail = JSON.stringify(result.json?.error ?? result.json ?? {});
      const detail = `${result.stdout}\n${result.stderr}`
        .split("\n")
        .slice(-30)
        .join(" ")
        .slice(0, 2000);
      throw new Error(
        `${id} exited ${result.exitCode} with status ${String(status)}: ${structuredDetail} ${detail}`,
      );
    }
  }, SMOKE_TEST_TIMEOUT_MS);
}

const EXPECTED_SKILL = "---\nname: mock-workflow\ndescription: Test fixture skill.\nworkflow: mock-workflow\n---\n\n# Mock Workflow\n";

function runCreateWorkflowSkillCase(mode) {
  const { repo, env } = initWorkflowPack();
  const runId = `create-workflow-skill-${mode}`;
  const caseEnv = { ...env, SMITHERS_TEST_SKILL_MODE: mode };
  const result = runSmithers(
    ["workflow", "run", "create-workflow", "--run-id", runId, "--input", JSON.stringify(workflowInput("create-workflow"))],
    { cwd: repo.dir, format: "json", env: caseEnv, timeoutMs: SMOKE_COMMAND_TIMEOUT_MS },
  );
  const verification = runSmithers(["output", runId, "skill-verification"], {
    cwd: repo.dir,
    format: "json",
    env: caseEnv,
    timeoutMs: SMOKE_COMMAND_TIMEOUT_MS,
  });
  return { repo, result, verification, runId, env: caseEnv };
}

test("create-workflow accepts exactly one valid companion skill and reports its terminal skillPath", () => {
  const { repo, result, runId, env } = runCreateWorkflowSkillCase("positive");
  expect(result.exitCode).toBe(0);
  expect(result.json?.status).toBe("finished");
  expect(repo.read(".smithers/skills/mock-workflow.md")).toBe(EXPECTED_SKILL);
  expect(repo.exists(".smithers/skills/mock-workflow/SKILL.md")).toBe(false);
  const terminal = runSmithers(["output", runId, "output"], { cwd: repo.dir, format: "json", env, timeoutMs: SMOKE_COMMAND_TIMEOUT_MS });
  expect(terminal.exitCode).toBe(0);
  expect(terminal.stdout).toContain('"skill_path":".smithers/skills/mock-workflow.md"');
}, SMOKE_TEST_TIMEOUT_MS);

test("create-workflow retries an invalid skill document and succeeds with exact metadata", () => {
  const { repo, result, runId, env } = runCreateWorkflowSkillCase("retry");
  expect(result.exitCode).toBe(0);
  expect(repo.read(".smithers/test-document-attempts")).toBe("2");
  expect(repo.read(".smithers/skills/mock-workflow.md")).toBe(EXPECTED_SKILL);
  const terminal = runSmithers(["output", runId, "output"], { cwd: repo.dir, format: "json", env, timeoutMs: SMOKE_COMMAND_TIMEOUT_MS });
  expect(terminal.stdout).toContain('"skill_path":".smithers/skills/mock-workflow.md"');
}, SMOKE_TEST_TIMEOUT_MS);

for (const mode of ["missing", "malformed", "mismatched", "wrong-path"]) {
  test(`create-workflow fails after bounded retries for a ${mode} companion skill`, () => {
    const { repo, result, verification } = runCreateWorkflowSkillCase(mode);
    expect(result.exitCode).not.toBe(0);
    expect(repo.read(".smithers/test-document-attempts")).toBe("3");
    expect(verification.exitCode).toBe(0);
    if (mode === "missing") {
      expect(repo.exists(".smithers/skills/mock-workflow.md")).toBe(false);
      expect(verification.stdout).toContain('"skill_path":".smithers/skills/mock-workflow.md"');
    } else if (mode === "wrong-path") {
      expect(repo.exists(".smithers/skills/mock-workflow.md")).toBe(false);
      expect(repo.read(".smithers/skills/wrong.md")).toContain("workflow: mock-workflow");
      expect(verification.stdout).toContain('"skill_path":".smithers/skills/wrong.md"');
    } else {
      expect(repo.exists(".smithers/skills/mock-workflow.md")).toBe(true);
      expect(verification.stdout).toContain('"skill_path":".smithers/skills/mock-workflow.md"');
    }
    expect(verification.stdout).toContain('"contains_workflow_metadata":false');
  }, SMOKE_TEST_TIMEOUT_MS);
}
