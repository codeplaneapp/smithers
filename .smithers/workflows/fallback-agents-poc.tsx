// smithers-source: user
// smithers-metadata-version: 1
// smithers-display-name: Fallback Agents POC
// smithers-description: Prove the global subscription pool works: run one agent task through fallbackAgents() (every registered Claude/Codex account, randomly ordered, stock agent last) and report which account actually served it.
// smithers-tags: poc, accounts, fallback
/** @jsxImportSource smthrs */
import { UI, createSmithers, fallbackAgents } from "smthrs";
import { z } from "zod/v4";

const inputSchema = z.object({});

// The probe task makes the account wiring observable: the agent reports the
// config-dir env var its own CLI process was spawned with.
const probeSchema = z.object({
  engine: z.enum(["claude", "codex"]).describe("Which CLI answered."),
  configDir: z
    .string()
    .describe("Value of CLAUDE_CONFIG_DIR (claude) or CODEX_HOME (codex) in your environment, or 'default' if unset."),
});

const outputSchema = z.object({
  chain: z.array(z.string()).describe("The failover chain that was declared, in shuffled order."),
  servedBy: z.string().describe("engine + config dir the probe actually ran under."),
});

const { Workflow, Task, Sequence, smithers, outputs } = createSmithers({
  input: inputSchema,
  probe: probeSchema,
  output: outputSchema,
});

/**
 * POC for the global fallback-agents pool. `fallbackAgents()` reads
 * ~/.smithers/accounts.json, shuffles one agent per registered Claude/Codex
 * subscription, and appends the stock agent as the last rung — so this
 * workflow runs on any machine, registered accounts or not. The probe task
 * echoes its config-dir env var, proving the per-account isolation reached
 * the spawned CLI.
 */
export default smithers((ctx) => {
  // seed: ctx.runId keeps one run's chain stable across renders and retries
  // (precise per-rung quota skipping) while still shuffling run-to-run.
  const chain = fallbackAgents({ seed: ctx.runId });
  const chainLabels = chain.map(
    (agent) =>
      (agent as { opts?: { id?: string } }).opts?.id ?? `${agent.constructor?.name ?? "agent"} (normal fallback)`,
  );
  const probe = ctx.outputMaybe("probe", { nodeId: "probe" });
  return (
    <Workflow name="fallback-agents-poc">
      <UI entry="../ui/fallback-agents-poc.tsx" title="Fallback Agents POC" />
      <Sequence>
        <Task id="probe" output={outputs.probe} agent={chain}>
          {"Run this exact bash command: `echo claude:${CLAUDE_CONFIG_DIR:-unset} codex:${CODEX_HOME:-unset}`. " +
            "Then answer: engine = 'claude' if you are Claude Code, 'codex' if you are Codex. " +
            "configDir = the value of YOUR engine's variable from the echo output, or 'default' if it printed 'unset'."}
        </Task>
        {probe ? (
          <Task id="output" output={outputs.output}>
            {() => ({ chain: chainLabels, servedBy: `${probe.engine}: ${probe.configDir}` })}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
