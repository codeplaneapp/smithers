import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { GENERATED_SEEDED_FILES } from "../src/seeded-workflow-pack.generated.js";
import {
  createExecutableDir,
  createTempRepo,
  runSmithers,
  writeExecutable,
} from "../../../packages/smithers/tests/e2e-helpers.js";

const CLI_ENTRY = resolve(import.meta.dir, "../src/index.js");

const SEEDED_WORKFLOW_IDS = GENERATED_SEEDED_FILES.filter(
  (file) => file.path.startsWith(".smithers/workflows/") && file.path.endsWith(".tsx"),
)
  .map((file) =>
    file.path
      .split("/")
      .pop()
      .replace(/\.tsx$/, ""),
  )
  .sort();

const SMOKE_COMMAND_TIMEOUT_MS = 120_000;
const SMOKE_TEST_TIMEOUT_MS = 180_000;

test("every generated workflow runtime file reference is bundled", () => {
  const generatedPaths = new Set(GENERATED_SEEDED_FILES.map((file) => file.path));
  for (const file of GENERATED_SEEDED_FILES) {
    if (file.path.startsWith(".smithers/workflows/")) {
      for (const match of file.contents.matchAll(
        /resolve\s*\(\s*import\.meta\.dir\s*,\s*["']\.\.\/lib\/([^"']+)["']\s*\)/g,
      )) {
        expect(generatedPaths.has(`.smithers/lib/${match[1]}`), `${file.path} references ${match[1]}`).toBe(true);
      }
    }
    if (file.path.startsWith(".smithers/lib/") && file.path.endsWith(".json")) {
      const visit = (value) => {
        if (typeof value === "string" && value.startsWith(".smithers/lib/")) {
          expect(generatedPaths.has(value), `${file.path} references ${value}`).toBe(true);
        } else if (Array.isArray(value)) {
          value.forEach(visit);
        } else if (value && typeof value === "object") {
          Object.values(value).forEach(visit);
        }
      };
      visit(JSON.parse(file.contents));
    }
  }
});

const AGENT_RESPONSE = JSON.stringify({
  completed: true,
  detail: "completed the seeded smoke-test fixture",
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
  targetWorkflow: "hello",
  uiPath: ".smithers/ui/hello.tsx",
  verified: false,
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
  gates: [
    {
      criterion: "The run completes.",
      verificationMethod: "schema",
      gateType: "blocking",
      checkedBy: "seeded smoke test",
      failureAction: "fail the run",
      evidenceRequired: ["finished status"],
      humanApprovalRequired: false,
    },
  ],
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
  // create-workflow's clarify step right-sizes the request into a `route`
  // OBJECT (tier/reason/oneshotCommand). A bare string fails schema validation,
  // and the engine's default agent retries then spin until the harness command
  // timeout — which is what made every create-workflow case burn ~120s.
  route: { tier: "workflow", reason: "The fixture exercises the full authoring pipeline.", oneshotCommand: null },
  reportPath: null,
  branch: null,
  prUrl: null,
  ticketCount: 0,
  mustFixCount: 0,
  implRunId: null,
});

const WORKFLOW_INPUTS = {
  add: { spec: "file:fixture-pack" },
  "create-skill": { prompt: "Create a tiny test skill.", review: false, name: "mock-skill" },
  "create-ui": { targetWorkflow: "hello" },
  "create-workflow": { prompt: "Create a tiny test workflow.", review: false, name: "mock-workflow" },
  "context-engineer": { prompt: "Plan a tiny safe change.", review: false },
  "post-failure": { targetRunId: "missing-run" },
  "share-pack": { repo: "smithersai/seeded-smoke-pack", dryRun: true },
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
  writeExecutable(
    binDir,
    "bunx",
    [
      "#!/usr/bin/env bun",
      'import { spawnSync } from "node:child_process";',
      `const cliEntry = ${JSON.stringify(CLI_ENTRY)};`,
      "const args = process.argv.slice(2);",
      'if (args[0] !== "smthrs") {',
      '  process.stderr.write(`unsupported bunx command in test fixture: ${args.join(" ")}\\n`);',
      "  process.exit(127);",
      "}",
      'const child = spawnSync(process.execPath, ["run", cliEntry, ...args.slice(1)], {',
      "  cwd: process.cwd(),",
      "  env: process.env,",
      '  stdio: "inherit",',
      "});",
      "process.exit(child.status ?? (child.signal ? 1 : 0));",
      "",
    ].join("\n"),
  );
}

function writeFakeAgentBinaries(binDir) {
  const fixtureScript = [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'let stdin = ""; try { stdin = fs.readFileSync(0, "utf8"); } catch {}',
    'const invocation = (process.argv.slice(2).join(" ") + "\\n" + stdin).toLowerCase();',
    // Match the distinct prompt headers plus their opening instructions. The
    // invocation includes every workflow prompt, so broad words such as
    // "scaffold" and "document" would make this fixture write at the wrong
    // stage and conceal retry regressions.
    'const scaffoldStage = invocation.includes("# scaffold the workflow files\\n\\nyou are the scaffolder.");',
    'const documentStage = invocation.includes("# document the new workflow\\n\\nthe new workflow verifies cleanly.");',
    'const completeManifestStage = invocation.includes("the pack manifest .smithers/smithers.toon in this repository is incomplete:");',
    // create-workflow's clarify step right-sizes the ask first: its `route` is
    // an object, while `smithering` uses a plain string of the same name. One
    // shared fixture payload cannot satisfy both, so specialize it per stage.
    'const workflowClarifyStage = invocation.includes("# clarify the workflow request\\n\\nyou are the intake step");',
    "function writeFixtureFiles() {",
    "  const root = process.cwd();",
    '  const workflowDir = path.join(root, ".smithers", "workflows");',
    "  fs.mkdirSync(workflowDir, { recursive: true });",
    '  fs.writeFileSync(path.join(workflowDir, "mock-workflow.tsx"), [',
    '    "// smithers-source: generated",',
    '    "// smithers-metadata-version: 1",',
    '    "// smithers-display-name: Mock Workflow",',
    '    "/** @jsxImportSource smthrs */",',
    '    "import { createSmithers } from \\"smthrs\\";",',
    '    "import { z } from \\"zod/v4\\";",',
    '    "const { Workflow, Task, smithers, outputs } = createSmithers({ output: z.object({ summary: z.string() }) });",',
    '    "export default smithers(() => (",',
    '    "  <Workflow name=\\"mock-workflow\\">",',
    '    "    <Task id=\\"output\\" output={outputs.output}>{() => ({ summary: \\"mock workflow ok\\" })}</Task>",',
    '    "  </Workflow>",',
    '    "));",',
    '    "",',
    '  ].join("\\n"), "utf8");',
    // A workflow and its registered test are one indivisible change: verify
    // fails the run outright when the test is missing or unregistered, so the
    // scaffolder fixture must produce both, exactly like a real one.
    '  const testsDir = path.join(root, ".smithers", "tests");',
    "  fs.mkdirSync(testsDir, { recursive: true });",
    '  fs.writeFileSync(path.join(testsDir, "mock-workflow.test.tsx"), [',
    '    "import { expect, test } from \\"bun:test\\";",',
    '    "import { join } from \\"node:path\\";",',
    '    "import { renderWorkflow } from \\"smthrs/testing\\";",',
    '    "import workflow from \\"../workflows/mock-workflow.tsx\\";",',
    '    "test(\\"renders the real mock workflow graph\\", async () => {",',
    '    "  const graph = await renderWorkflow(workflow, { workflowPath: join(import.meta.dir, \\"..\\", \\"workflows\\", \\"mock-workflow.tsx\\"), input: {}, outputs: {} });",',
    '    "  expect(graph.tasks.map((task) => task.nodeId)).toEqual([\\"output\\"]);",',
    '    "  const output = graph.tasks.find((task) => task.nodeId === \\"output\\");",',
    '    "  expect(output?.outputSchema.safeParse({ summary: \\"ok\\" }).success).toBe(true);",',
    '    "  expect(output?.outputSchema.safeParse({ summary: 1 }).success).toBe(false);",',
    '    "});",',
    '    "",',
    '  ].join("\\n"), "utf8");',
    '  const packageJsonPath = path.join(root, ".smithers", "package.json");',
    "  const packageJson = fs.existsSync(packageJsonPath)",
    '    ? JSON.parse(fs.readFileSync(packageJsonPath, "utf8"))',
    '    : { name: "smithers-pack", private: true, scripts: {} };',
    "  packageJson.scripts = packageJson.scripts || {};",
    '  const existingTestScript = packageJson.scripts.test || "bun test --preload ./preload.ts";',
    '  if (!existingTestScript.includes("./tests/mock-workflow.test.tsx")) {',
    '    packageJson.scripts.test = existingTestScript + " ./tests/mock-workflow.test.tsx";',
    "  }",
    '  fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + "\\n", "utf8");',
    '  const countPath = path.join(root, ".smithers", "test-scaffold-count");',
    '  const count = Number(fs.existsSync(countPath) ? fs.readFileSync(countPath, "utf8") : "0") + 1;',
    '  fs.writeFileSync(countPath, String(count), "utf8");',
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
    "function completeManifestFixture() {",
    '  const manifestPath = path.join(process.cwd(), ".smithers", "smithers.toon");',
    '  const manifest = fs.readFileSync(manifestPath, "utf8").replace(/^description:.*$/m, "description: Seeded smoke-test pack");',
    '  fs.writeFileSync(manifestPath, manifest, "utf8");',
    "}",
    "if (scaffoldStage) writeFixtureFiles();",
    "if (documentStage) writeSkillFixture();",
    "if (completeManifestStage) completeManifestFixture();",
  ].join("\n");
  const responseLiteral = JSON.stringify(AGENT_RESPONSE);
  writeExecutable(
    binDir,
    "claude",
    [
      "#!/usr/bin/env bun",
      fixtureScript,
      "const args = process.argv.slice(2);",
      'if (args.join(" ") === "auth status") {',
      '  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }) + "\\n");',
      "  process.exit(0);",
      "}",
      `let payload = process.env.SMITHERS_FAKE_AGENT_RESPONSE ?? ${responseLiteral};`,
      'if (documentStage && process.env.SMITHERS_TEST_SKILL_MODE === "wrong-path") { const parsed = JSON.parse(payload); parsed.skillPath = ".smithers/skills/wrong.md"; payload = JSON.stringify(parsed); }',
      'if (workflowClarifyStage) { const parsed = JSON.parse(payload); parsed.route = { tier: "workflow", reason: "Fixture builds a workflow.", oneshotCommand: null }; payload = JSON.stringify(parsed); }',
      'process.stdout.write(JSON.stringify({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "```json\\n" + payload + "\\n```\\n" }] } }) + "\\n");',
      "",
    ].join("\n"),
  );
  writeExecutable(
    binDir,
    "codex",
    [
      "#!/usr/bin/env bun",
      fixtureScript,
      `let payload = process.env.SMITHERS_FAKE_AGENT_RESPONSE ?? ${responseLiteral};`,
      'if (documentStage && process.env.SMITHERS_TEST_SKILL_MODE === "wrong-path") { const parsed = JSON.parse(payload); parsed.skillPath = ".smithers/skills/wrong.md"; payload = JSON.stringify(parsed); }',
      'if (workflowClarifyStage) { const parsed = JSON.parse(payload); parsed.route = { tier: "workflow", reason: "Fixture builds a workflow.", oneshotCommand: null }; payload = JSON.stringify(parsed); }',
      "const args = process.argv.slice(2);",
      'const outputIndex = args.indexOf("--output-last-message");',
      "if (outputIndex >= 0 && args[outputIndex + 1]) {",
      '  fs.writeFileSync(args[outputIndex + 1], payload + "\\n", "utf8");',
      "}",
      'process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\\n");',
      "",
    ].join("\n"),
  );
  writeExecutable(
    binDir,
    "agy",
    [
      "#!/usr/bin/env bun",
      fixtureScript,
      `let payload = process.env.SMITHERS_FAKE_AGENT_RESPONSE ?? ${responseLiteral};`,
      'if (documentStage && process.env.SMITHERS_TEST_SKILL_MODE === "wrong-path") { const parsed = JSON.parse(payload); parsed.skillPath = ".smithers/skills/wrong.md"; payload = JSON.stringify(parsed); }',
      'if (workflowClarifyStage) { const parsed = JSON.parse(payload); parsed.route = { tier: "workflow", reason: "Fixture builds a workflow.", oneshotCommand: null }; payload = JSON.stringify(parsed); }',
      'process.stdout.write(payload + "\\n");',
      "",
    ].join("\n"),
  );
}

function initWorkflowPack() {
  const repo = createTempRepo();
  const binDir = createExecutableDir();
  writeFakeAgentBinaries(binDir);
  writeBunxShim(binDir);
  repo.write(".claude/.credentials.json", "{}\n");
  repo.write(
    ".codex/auth.json",
    JSON.stringify({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: { access_token: "fake-access-token", account_id: "acct_test" },
    }) + "\n",
  );
  repo.write(".gemini/antigravity-cli/settings.json", "{}\n");
  repo.write("registry-readme.md", "# Awesome Smithers\n\n## Packs\n\n");
  const env = {
    HOME: repo.dir,
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    ANTHROPIC_API_KEY: "",
    OPENAI_API_KEY: "",
    GEMINI_API_KEY: "",
    GOOGLE_API_KEY: "",
    // Several seeded-workflow cases deliberately fail. Keep those failures
    // from spawning detached autopsies that can outlive this fixture's fake
    // agent binaries and fall through to real credentials on the host.
    SMITHERS_POST_FAILURE: "0",
    SMITHERS_FAKE_AGENT_RESPONSE: AGENT_RESPONSE,
    SMITHERS_SHARE_REGISTRY_README: repo.path("registry-readme.md"),
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
    "add",
    "create-skill",
    "create-ui",
    "create-workflow",
    "eval-suite-run",
    "init",
    "post-failure",
    "share-pack",
    "upgrade",
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
  if (id === "create-ui") {
    // create-ui's compliance loop became a HARD gate (author must report
    // verified=true and the gate independently checks the served Gateway
    // routes). This harness runs a bare engine with fake agents and no
    // gateway, so the only healthy outcome is failing closed at the
    // iteration cap -- completing "successfully" here would be the exact
    // unverified-UI false-pass the gate exists to prevent.
    test(
      `seeded workflow ${id} fails closed without a verifiable gateway UI`,
      () => {
        const { repo, env } = initWorkflowPack();
        const result = runSmithers(["workflow", "run", id, "--input", JSON.stringify(workflowInput(id))], {
          cwd: repo.dir,
          format: "json",
          env,
          timeoutMs: SMOKE_COMMAND_TIMEOUT_MS,
        });
        expect(result.exitCode).not.toBe(0);
        expect(result.json?.status).toBe("failed");
        expect(JSON.stringify(result.json?.error ?? {})).toContain("RALPH_MAX_REACHED");
      },
      SMOKE_TEST_TIMEOUT_MS,
    );
    continue;
  }
  test(
    `seeded workflow ${id} runs with fake agents`,
    () => {
      const { repo, env } = initWorkflowPack();
      if (id === "add") {
        repo.write(
          "fixture-pack/smithers.toon",
          [
            "name: seeded-smoke-fixture",
            "version: 1.0.0",
            "description: Seeded add workflow smoke fixture",
            "capabilities:",
            "  writes: none",
            "",
          ].join("\n"),
        );
        repo.write("fixture-pack/workflows/hello.tsx", "export default null;\n");
      }
      const result = runSmithers(["workflow", "run", id, "--input", JSON.stringify(workflowInput(id))], {
        cwd: repo.dir,
        format: "json",
        env,
        timeoutMs: SMOKE_COMMAND_TIMEOUT_MS,
      });
      const status = result.json?.status;
      if (!isValidSmokeOutcome(id, status, result.exitCode)) {
        const structuredDetail = JSON.stringify(result.json?.error ?? result.json ?? {});
        const detail = `${result.stdout}\n${result.stderr}`.split("\n").slice(-30).join(" ").slice(0, 2000);
        throw new Error(`${id} exited ${result.exitCode} with status ${String(status)}: ${structuredDetail} ${detail}`);
      }
    },
    SMOKE_TEST_TIMEOUT_MS,
  );
}

const EXPECTED_SKILL =
  "---\nname: mock-workflow\ndescription: Test fixture skill.\nworkflow: mock-workflow\n---\n\n# Mock Workflow\n";
const EXPECTED_WORKFLOW = [
  "// smithers-source: generated",
  "// smithers-metadata-version: 1",
  "// smithers-display-name: Mock Workflow",
  "/** @jsxImportSource smthrs */",
  'import { createSmithers } from "smthrs";',
  'import { z } from "zod/v4";',
  "const { Workflow, Task, smithers, outputs } = createSmithers({ output: z.object({ summary: z.string() }) });",
  "export default smithers(() => (",
  '  <Workflow name="mock-workflow">',
  '    <Task id="output" output={outputs.output}>{() => ({ summary: "mock workflow ok" })}</Task>',
  "  </Workflow>",
  "));",
  "",
].join("\n");

function jsonOutput(result) {
  return JSON.parse(result.stdout);
}

function skillFrontmatter(contents) {
  const match = contents.match(/^---\n([\s\S]*?)\n---\n/);
  return match ? parseYaml(match[1]) : null;
}

function workflowMetadata(contents) {
  const fields = Object.fromEntries(
    [...contents.matchAll(/^\/\/ smithers-([^:]+): (.+)$/gm)].map((match) => [match[1], match[2]]),
  );
  return {
    source: fields.source,
    metadataVersion: fields["metadata-version"],
    displayName: fields["display-name"],
  };
}

function companionSkillPaths(repo) {
  return readdirSync(repo.path(".smithers/skills"))
    .filter((name) => name !== ".gitkeep")
    .sort();
}

function runCreateWorkflowSkillCase(mode) {
  const { repo, env } = initWorkflowPack();
  const runId = `create-workflow-skill-${mode}`;
  const caseEnv = { ...env, SMITHERS_TEST_SKILL_MODE: mode };
  const result = runSmithers(
    [
      "workflow",
      "run",
      "create-workflow",
      "--run-id",
      runId,
      "--input",
      JSON.stringify(workflowInput("create-workflow")),
    ],
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

test(
  "create-workflow accepts exactly one valid companion skill and reports its terminal skillPath",
  () => {
    const { repo, result, runId, env } = runCreateWorkflowSkillCase("positive");
    expect(result.exitCode).toBe(0);
    expect(result.json?.status).toBe("finished");
    expect(repo.read(".smithers/test-scaffold-count")).toBe("1");
    expect(repo.read(".smithers/workflows/mock-workflow.tsx")).toBe(EXPECTED_WORKFLOW);
    expect(workflowMetadata(repo.read(".smithers/workflows/mock-workflow.tsx"))).toEqual({
      source: "generated",
      metadataVersion: "1",
      displayName: "Mock Workflow",
    });
    expect(repo.read(".smithers/skills/mock-workflow.md")).toBe(EXPECTED_SKILL);
    expect(repo.exists(".smithers/skills/mock-workflow/SKILL.md")).toBe(false);
    expect(skillFrontmatter(repo.read(".smithers/skills/mock-workflow.md"))).toEqual({
      name: "mock-workflow",
      description: "Test fixture skill.",
      workflow: "mock-workflow",
    });
    expect(companionSkillPaths(repo)).toEqual(["mock-workflow.md"]);
    expect(readdirSync(repo.path(".smithers/skills")).sort()).toEqual([".gitkeep", "mock-workflow.md"]);
    expect(repo.read(".smithers/test-document-attempts")).toBe("1");
    const terminal = runSmithers(["output", runId, "output"], {
      cwd: repo.dir,
      format: "json",
      env,
      timeoutMs: SMOKE_COMMAND_TIMEOUT_MS,
    });
    expect(terminal.exitCode).toBe(0);
    expect(jsonOutput(terminal)).toMatchObject({ skill_path: ".smithers/skills/mock-workflow.md" });
  },
  SMOKE_TEST_TIMEOUT_MS,
);

test(
  "create-workflow retries an invalid skill document and succeeds with exact metadata",
  () => {
    const { repo, result, runId, env } = runCreateWorkflowSkillCase("retry");
    expect(result.exitCode).toBe(0);
    expect(result.json?.status).toBe("finished");
    expect(repo.read(".smithers/test-document-attempts")).toBe("2");
    expect(repo.read(".smithers/test-scaffold-count")).toBe("1");
    expect(repo.read(".smithers/workflows/mock-workflow.tsx")).toBe(EXPECTED_WORKFLOW);
    expect(workflowMetadata(repo.read(".smithers/workflows/mock-workflow.tsx"))).toEqual({
      source: "generated",
      metadataVersion: "1",
      displayName: "Mock Workflow",
    });
    expect(repo.read(".smithers/skills/mock-workflow.md")).toBe(EXPECTED_SKILL);
    expect(repo.exists(".smithers/skills/mock-workflow/SKILL.md")).toBe(false);
    expect(skillFrontmatter(repo.read(".smithers/skills/mock-workflow.md"))).toEqual({
      name: "mock-workflow",
      description: "Test fixture skill.",
      workflow: "mock-workflow",
    });
    expect(companionSkillPaths(repo)).toEqual(["mock-workflow.md"]);
    expect(readdirSync(repo.path(".smithers/skills")).sort()).toEqual([".gitkeep", "mock-workflow.md"]);
    const terminal = runSmithers(["output", runId, "output"], {
      cwd: repo.dir,
      format: "json",
      env,
      timeoutMs: SMOKE_COMMAND_TIMEOUT_MS,
    });
    expect(terminal.exitCode).toBe(0);
    expect(jsonOutput(terminal)).toMatchObject({ skill_path: ".smithers/skills/mock-workflow.md" });
  },
  SMOKE_TEST_TIMEOUT_MS,
);

for (const mode of ["missing", "malformed", "mismatched", "wrong-path"]) {
  test(
    `create-workflow finishes with a null skillPath after bounded retries for a ${mode} companion skill`,
    () => {
      const { repo, result, runId, env, verification } = runCreateWorkflowSkillCase(mode);
      // A companion skill is best-effort: the workflow itself builds and
      // verifies, so the run FINISHES and downgrades skillPath to null rather
      // than throwing away a working workflow over its doc (the skill loop is
      // `onMaxReached: "return-last"`). The signal is the null terminal
      // skillPath plus the exhausted retry budget below, not a failed run.
      expect(result.exitCode).toBe(0);
      expect(result.json?.status).toBe("finished");
      const terminal = runSmithers(["output", runId, "output"], {
        cwd: repo.dir,
        format: "json",
        env,
        timeoutMs: SMOKE_COMMAND_TIMEOUT_MS,
      });
      expect(terminal.exitCode).toBe(0);
      expect(jsonOutput(terminal)).toMatchObject({ status: "built", skill_path: null });
      expect(result.stderr).not.toContain("Post-failure autopsy launched");
      expect(repo.read(".smithers/test-document-attempts")).toBe("3");
      expect(repo.read(".smithers/test-scaffold-count")).toBe("1");
      expect(repo.read(".smithers/workflows/mock-workflow.tsx")).toBe(EXPECTED_WORKFLOW);
      expect(workflowMetadata(repo.read(".smithers/workflows/mock-workflow.tsx"))).toEqual({
        source: "generated",
        metadataVersion: "1",
        displayName: "Mock Workflow",
      });
      expect(verification.exitCode).toBe(0);
      const verificationOutput = jsonOutput(verification);
      expect(verificationOutput).toMatchObject({
        skill_path: mode === "wrong-path" ? ".smithers/skills/wrong.md" : ".smithers/skills/mock-workflow.md",
        exists: mode !== "missing" && mode !== "wrong-path",
        contains_workflow_metadata: false,
      });
      expect(repo.exists(".smithers/skills/mock-workflow/SKILL.md")).toBe(false);
      if (mode === "missing") {
        expect(repo.exists(".smithers/skills/mock-workflow.md")).toBe(false);
        expect(companionSkillPaths(repo)).toEqual([]);
        expect(readdirSync(repo.path(".smithers/skills")).sort()).toEqual([".gitkeep"]);
      } else if (mode === "wrong-path") {
        expect(repo.exists(".smithers/skills/mock-workflow.md")).toBe(false);
        expect(repo.read(".smithers/skills/wrong.md")).toBe(
          "---\nname: mock-workflow\nworkflow: mock-workflow\n---\nwrong path\n",
        );
        expect(skillFrontmatter(repo.read(".smithers/skills/wrong.md"))).toMatchObject({
          name: "mock-workflow",
          workflow: "mock-workflow",
        });
        expect(companionSkillPaths(repo)).toEqual(["wrong.md"]);
        expect(readdirSync(repo.path(".smithers/skills")).sort()).toEqual([".gitkeep", "wrong.md"]);
      } else {
        expect(repo.exists(".smithers/skills/mock-workflow.md")).toBe(true);
        const expected =
          mode === "malformed"
            ? "---\nname: [unterminated\nworkflow: mock-workflow\n---\n"
            : "---\nname: other-workflow\nworkflow: mock-workflow\n---\n";
        expect(repo.read(".smithers/skills/mock-workflow.md")).toBe(expected);
        expect(companionSkillPaths(repo)).toEqual(["mock-workflow.md"]);
        expect(readdirSync(repo.path(".smithers/skills")).sort()).toEqual([".gitkeep", "mock-workflow.md"]);
        if (mode === "mismatched") {
          expect(skillFrontmatter(expected)).toMatchObject({ name: "other-workflow", workflow: "mock-workflow" });
        }
      }
    },
    SMOKE_TEST_TIMEOUT_MS,
  );
}
