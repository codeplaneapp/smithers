// smithers-source: user
// smithers-display-name: OpenClaw Integration Hardening
/** @jsxImportSource smithers-orchestrator */
import { ClaudeCodeAgent, Parallel, Sequence, createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { codexFirst } from "../lib/codexAccounts";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const AGENT_AUDIT_TIMEOUT_MS = 2 * 60_000;

const inputSchema = z.object({
  mode: z.enum(["verify", "implement"]).default("verify"),
  allowEdits: z.boolean().default(false),
  focus: z.string().default("OpenClaw plugin, OpenClaw workflow agent adapter, Claude/Codex/Hermes/OpenClaw integration tests, and the OpenClaw marketing site."),
});

const auditSchema = z.object({
  status: z.enum(["pass", "needs-work"]),
  summary: z.string(),
  findings: z.array(z.string()).default([]),
  testGaps: z.array(z.string()).default([]),
  filesReviewed: z.array(z.string()).default([]),
  commandsRun: z.array(z.string()).default([]),
});

const commandCheckSchema = z.object({
  status: z.enum(["pass", "fail"]),
  commands: z.array(z.object({
    command: z.string(),
    exitCode: z.number(),
    tail: z.string(),
  })),
});

const summarySchema = z.object({
  status: z.enum(["pass", "needs-work"]),
  summary: z.string(),
  failingAreas: z.array(z.string()).default([]),
  nextCommands: z.array(z.string()).default([]),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: inputSchema,
  audit: auditSchema,
  commandCheck: commandCheckSchema,
  summary: summarySchema,
});

const fableFallback = new ClaudeCodeAgent({ model: "claude-fable-5", cwd: REPO });
const fable = codexFirst({ model: "gpt-5.6-sol", cwd: REPO, skipGitRepoCheck: true }, [fableFallback]);
const codex = codexFirst({ model: "gpt-5.6-sol", cwd: REPO, skipGitRepoCheck: true }, [fableFallback]);

function guard(mode: string, allowEdits: boolean) {
  return allowEdits || mode === "implement"
    ? "You may edit files if needed, but keep changes focused and run verification."
    : "Verify only. Do not edit files, stage files, commit, or run destructive commands.";
}

function auditPrompt(role: string, focus: string, mode: string, allowEdits: boolean) {
  return [
    `You are the ${role} for OpenClaw integration hardening in ${REPO}.`,
    guard(mode, allowEdits),
    "",
    "Scope:",
    focus,
    "",
    "Review these areas:",
    "- Claude Code, Codex, Hermes, and OpenClaw integration wiring.",
    "- OpenClaw native plugin behavior: tool contracts, config preservation, idempotent install, workflow creation guidance, eval and optimize tools.",
    "- OpenClaw as a Smithers workflow worker through OpenClawAgent and smithers init detection.",
    "- Unit and e2e coverage for agent wiring, agent detection, init, capability registries, and CLI surfaces.",
    "- Static OpenClaw marketing site clarity for non-technical users.",
    "",
    "Return JSON only matching the provided schema. Be specific about files and commands.",
  ].join("\n");
}

async function runCommand(command: string) {
  const proc = Bun.spawn(["bash", "-lc", command], {
    cwd: REPO,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  const combined = `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}`;
  return {
    command,
    exitCode,
    tail: combined.length > 7000 ? combined.slice(combined.length - 7000) : combined,
  };
}

export default smithers((ctx) => {
  const auditIds = [
    "fable-integration-audit",
    "codex-test-hardening-audit",
    "codex-openclaw-worker-audit",
    "fable-marketing-audit",
  ];

  return (
    <Workflow name="openclaw-integration-hardening">
      <Sequence>
        <Parallel maxConcurrency={5}>
          <Task id="fable-integration-audit" output={outputs.audit} agent={fable} timeoutMs={AGENT_AUDIT_TIMEOUT_MS} continueOnFail noRetry>
            {auditPrompt("Claude Fable integration reviewer", ctx.input.focus, ctx.input.mode, ctx.input.allowEdits)}
          </Task>

          <Task id="codex-test-hardening-audit" output={outputs.audit} agent={codex} timeoutMs={AGENT_AUDIT_TIMEOUT_MS} continueOnFail noRetry>
            {auditPrompt("Codex unit and e2e coverage reviewer", ctx.input.focus, ctx.input.mode, ctx.input.allowEdits)}
          </Task>

          <Task id="codex-openclaw-worker-audit" output={outputs.audit} agent={codex} timeoutMs={AGENT_AUDIT_TIMEOUT_MS} continueOnFail noRetry>
            {auditPrompt("Codex OpenClaw workflow-agent reviewer", ctx.input.focus, ctx.input.mode, ctx.input.allowEdits)}
          </Task>

          <Task id="fable-marketing-audit" output={outputs.audit} agent={fable} timeoutMs={AGENT_AUDIT_TIMEOUT_MS} continueOnFail noRetry>
            {auditPrompt("Claude Fable non-technical marketing-site reviewer", ctx.input.focus, ctx.input.mode, ctx.input.allowEdits)}
          </Task>

          <Task id="targeted-tests" output={outputs.commandCheck} timeoutMs={10 * 60_000} noRetry>
            {async () => {
              const commands = [
                "bun test packages/agents/tests/openclaw-support.test.js packages/agents/tests/cli-capabilities.test.js packages/agents/tests/capability-registry.test.js",
                "bun test apps/cli/tests/agent-wiring.test.js apps/cli/tests/cli-agent-detection.test.js apps/cli/tests/init-agents.e2e.test.js apps/cli/tests/docs-public-surface-coverage.test.js",
              ];
              const results: Awaited<ReturnType<typeof runCommand>>[] = [];
              for (const command of commands) {
                results.push(await runCommand(command));
              }
              return {
                status: results.every((result) => result.exitCode === 0) ? "pass" : "fail",
                commands: results,
              };
            }}
          </Task>
        </Parallel>

        <Task id="synthesis" output={outputs.summary} dependsOn={["targeted-tests", ...auditIds]} noRetry>
          {() => {
            const auditResults = auditIds.map((id) => ({
              id,
              output: ctx.outputMaybe(outputs.audit, { nodeId: id }),
            }));
            const audits = auditResults
              .map((result) => result.output)
              .filter((audit): audit is NonNullable<typeof audit> => Boolean(audit));
            const checks = ctx.outputMaybe(outputs.commandCheck, { nodeId: "targeted-tests" });
            const failingAreas = [
              ...auditResults.flatMap((result) => result.output ? [] : [`${result.id} did not produce audit output.`]),
              ...audits.flatMap((audit) => audit.status === "pass" ? [] : audit.findings),
              ...(!checks ? ["targeted-tests did not produce command output."] : []),
              ...(checks?.status === "pass" ? [] : checks?.commands.filter((cmd) => cmd.exitCode !== 0).map((cmd) => cmd.command) ?? []),
            ];
            return {
              status: failingAreas.length === 0 ? "pass" : "needs-work",
              summary: failingAreas.length === 0
                ? "OpenClaw integration hardening checks passed."
                : "OpenClaw integration hardening found issues that need follow-up.",
              failingAreas,
              nextCommands: [
                "pnpm typecheck",
                "pnpm test",
                "pnpm -C e2e test",
              ],
            };
          }}
        </Task>
      </Sequence>
    </Workflow>
  );
});
