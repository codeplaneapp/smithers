import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { listAccounts } from "@smthrs/accounts";
import { AntigravityAgent } from "@smthrs/agents/AntigravityAgent";
import { ClaudeCodeAgent } from "@smthrs/agents/ClaudeCodeAgent";
import { CodexAgent } from "@smthrs/agents/CodexAgent";
import { KimiAgent } from "@smthrs/agents/KimiAgent";
import { PiAgent } from "@smthrs/agents/PiAgent";
import { SmithersError } from "@smthrs/errors";
import { createSmithersAgentContract, renderSmithersAgentPromptGuidance } from "@smthrs/agents/agent-contract";
import { describeUnavailableAgent, detectAvailableAgents, formatNoUsableAgentsMessage } from "./agent-detection.js";
/**
 * @typedef {typeof ASK_AGENT_IDS[number]} AskAgentId
 */
/**
 * @typedef {{ agent?: AskAgentId; listAgents?: boolean; dumpPrompt?: boolean; toolSurface?: SmithersToolSurface; noMcp?: boolean; printBootstrap?: boolean; }} AskOptions
 */
/** @typedef {import("@smthrs/agents/agent-contract").SmithersToolSurface} SmithersToolSurface */
/** @typedef {import("@smthrs/agents/agent-contract").SmithersAgentContract} SmithersAgentContract */
/** @typedef {import("@smthrs/agents/BaseCliAgent").BaseCliAgent} BaseCliAgent */
/** @typedef {import("./AgentAvailability.ts").AgentAvailability} AgentAvailability */
/** @typedef {import("@smthrs/accounts").Account} Account */
/** @typedef {"mcp-config-file" | "mcp-config-inline" | "mcp-allow-list" | "prompt-only"} AskBootstrapMode */
/** @typedef {AgentAvailability & { id: AskAgentId }} AskSupportedAvailability */
/** @typedef {{ availability: AskSupportedAvailability; bootstrapMode: AskBootstrapMode; selectionReason: string }} AskSelection */
/** @typedef {{ selection: AskSelection; codexAccount?: Account }} AskAttempt */
/** @typedef {{ mode: "mcp-config-file"; serverName: string; toolSurface: SmithersToolSurface; config: ReturnType<typeof buildJsonMcpConfig> } | { mode: "mcp-config-inline"; serverName: string; toolSurface: SmithersToolSurface; configOverrides: string[] } | { mode: "mcp-allow-list"; serverName: string; toolSurface: SmithersToolSurface; allowedMcpServerNames: string[]; note: string } | { mode: "prompt-only"; serverName: string; toolSurface: SmithersToolSurface; note: string }} AskBootstrap */

const ASK_AGENT_IDS = ["codex", "claude", "kimi", "antigravity", "pi"];
const DEFAULT_SERVER_NAME = "smithers";

/** @param {NodeJS.ProcessEnv} env */
function registeredCodexAccounts(env) {
  try {
    return listAccounts(env).filter((account) =>
      account.provider === "codex"
        ? Boolean(account.configDir?.trim())
        : account.provider === "openai-api" && Boolean(account.apiKey?.trim()),
    );
  } catch {
    return [];
  }
}

/**
 * A registered credential makes Codex usable when the binary exists even if
 * the ambient/default profile is logged out. The selected account is passed to
 * CodexAgent below; Claude/Kimi remain behind it as provider fallbacks.
 * @param {AgentAvailability[]} agents
 * @param {Account | undefined} account
 */
function withRegisteredCodexAvailability(agents, account) {
  if (!account) return agents;
  return agents.map((agent) =>
    agent.id !== "codex" || agent.usable || !agent.hasBinary
      ? agent
      : {
          ...agent,
          usable: true,
          status: account.provider === "openai-api" ? "api-key" : "likely-subscription",
          score: account.provider === "openai-api" ? 3 : 4,
          hasAuthSignal: account.provider === "codex",
          hasApiKeySignal: account.provider === "openai-api",
          unusableReasons: [],
          reason: `registered ${account.provider} account ${account.label}`,
        },
  );
}
/**
 * @param {AgentAvailability["id"]} value
 * @returns {value is AskAgentId}
 */
function isAskAgentId(value) {
  return ASK_AGENT_IDS.includes(value);
}
/**
 * @param {AgentAvailability} availability
 * @returns {availability is AskSupportedAvailability}
 */
function isSupportedAvailability(availability) {
  return isAskAgentId(availability.id);
}
/**
 * @param {AskAgentId} agentId
 * @returns {AskBootstrapMode}
 */
function resolveBootstrapMode(agentId, noMcp = false) {
  if (noMcp) {
    return "prompt-only";
  }
  switch (agentId) {
    case "claude":
    case "kimi":
      return "mcp-config-file";
    case "codex":
      return "mcp-config-inline";
    case "antigravity":
    case "pi":
      return "prompt-only";
  }
}
/**
 * @param {AskBootstrapMode} mode
 */
function bootstrapRank(mode) {
  switch (mode) {
    case "mcp-config-file":
    case "mcp-config-inline":
      return 3;
    case "mcp-allow-list":
      return 2;
    case "prompt-only":
      return 1;
  }
}
/**
 * @param {SmithersToolSurface} [toolSurface]
 * @returns {{ command: string; args: string[] }}
 */
function buildSmithersMcpLaunchSpec(toolSurface = "semantic") {
  return {
    command: process.execPath,
    args: ["run", resolve(dirname(fileURLToPath(import.meta.url)), "index.js"), "--mcp", "--surface", toolSurface],
  };
}
/**
 * @param {SmithersToolSurface} toolSurface
 */
function buildJsonMcpConfig(toolSurface, serverName = DEFAULT_SERVER_NAME) {
  const launchSpec = buildSmithersMcpLaunchSpec(toolSurface);
  return {
    mcpServers: {
      [serverName]: {
        command: launchSpec.command,
        args: launchSpec.args,
      },
    },
  };
}
/**
 * @param {SmithersToolSurface} [toolSurface]
 */
function buildSmithersMcpConfigFile(toolSurface = "semantic", serverName = DEFAULT_SERVER_NAME) {
  const dir = mkdtempSync(join(tmpdir(), "smithers-ask-"));
  const configPath = join(dir, "mcp.json");
  const contents = buildJsonMcpConfig(toolSurface, serverName);
  writeFileSync(configPath, JSON.stringify(contents, null, 2));
  return {
    dir,
    path: configPath,
    contents,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
/**
 * @param {SmithersToolSurface} toolSurface
 */
function buildCodexConfigOverrides(toolSurface, serverName = DEFAULT_SERVER_NAME) {
  const launchSpec = buildSmithersMcpLaunchSpec(toolSurface);
  return [
    `mcp_servers.${serverName}.command=${JSON.stringify(launchSpec.command)}`,
    `mcp_servers.${serverName}.args=${JSON.stringify(launchSpec.args)}`,
  ];
}
/**
 * @param {AskSelection} selection
 * @param {SmithersToolSurface} toolSurface
 * @returns {AskBootstrap}
 */
function buildBootstrap(selection, toolSurface) {
  switch (selection.bootstrapMode) {
    case "mcp-config-file":
      return {
        mode: "mcp-config-file",
        serverName: DEFAULT_SERVER_NAME,
        toolSurface,
        config: buildJsonMcpConfig(toolSurface),
      };
    case "mcp-config-inline":
      return {
        mode: "mcp-config-inline",
        serverName: DEFAULT_SERVER_NAME,
        toolSurface,
        configOverrides: buildCodexConfigOverrides(toolSurface),
      };
    case "mcp-allow-list":
      return {
        mode: "mcp-allow-list",
        serverName: DEFAULT_SERVER_NAME,
        toolSurface,
        allowedMcpServerNames: [DEFAULT_SERVER_NAME],
        note: "Gemini can only allow-list preconfigured MCP servers. Configure the local Smithers server under the same name before relying on MCP.",
      };
    case "prompt-only":
      return {
        mode: "prompt-only",
        serverName: DEFAULT_SERVER_NAME,
        toolSurface,
        note:
          selection.availability.id === "pi"
            ? "PI falls back to prompt-only bootstrap for smithers ask."
            : "MCP bootstrap is disabled for this run.",
      };
  }
}
/**
 * @param {AskSupportedAvailability} left
 * @param {AskSupportedAvailability} right
 */
function compareAgents(left, right, noMcp = false) {
  const leftBootstrap = resolveBootstrapMode(left.id, noMcp);
  const rightBootstrap = resolveBootstrapMode(right.id, noMcp);
  const bootstrapDelta = bootstrapRank(rightBootstrap) - bootstrapRank(leftBootstrap);
  if (bootstrapDelta !== 0) {
    return bootstrapDelta;
  }
  if (right.score !== left.score) {
    return right.score - left.score;
  }
  return ASK_AGENT_IDS.indexOf(left.id) - ASK_AGENT_IDS.indexOf(right.id);
}
/**
 * @param {AgentAvailability} agent
 */
function formatAgentChecks(agent) {
  return agent.checks.join(", ");
}
/**
 * @param {AgentAvailability[]} agents
 */
function noUsableAgentError(agents) {
  return new SmithersError("NO_USABLE_AGENTS", formatNoUsableAgentsMessage(agents));
}
/**
 * @param {AgentAvailability[]} agents
 * @param {AskOptions} options
 * @returns {AskSelection}
 */
function selectAgent(agents, options) {
  const supported = agents.filter(isSupportedAvailability);
  if (options.agent) {
    const explicit = supported.find((agent) => agent.id === options.agent);
    if (!explicit) {
      throw new SmithersError(
        "CLI_AGENT_UNSUPPORTED",
        `Agent "${options.agent}" is not supported for \`smithers ask\`.`,
        { agentId: options.agent },
      );
    }
    if (!explicit.usable) {
      throw new SmithersError(
        "NO_USABLE_AGENTS",
        `${describeUnavailableAgent(explicit)} Checked: ${formatAgentChecks(explicit)}`,
        { agentId: explicit.id },
      );
    }
    return {
      availability: explicit,
      bootstrapMode: resolveBootstrapMode(explicit.id, options.noMcp),
      selectionReason: "requested via --agent",
    };
  }
  const usable = supported.filter((agent) => agent.usable && !agent.deprecated);
  if (usable.length === 0) {
    throw noUsableAgentError(agents);
  }
  // Smithers is Codex-first: availability score chooses among fallback
  // engines only when Codex itself is unavailable. In particular, a Claude
  // subscription score (4) must not outrank usable Codex API-key auth (3).
  const best =
    usable.find((agent) => agent.id === "codex") ??
    [...usable].sort((left, right) => compareAgents(left, right, options.noMcp))[0];
  if (!best) {
    throw noUsableAgentError(agents);
  }
  const bootstrapMode = resolveBootstrapMode(best.id, options.noMcp);
  return {
    availability: best,
    bootstrapMode,
    selectionReason:
      best.id === "codex"
        ? `Codex is available; using Codex-first ${bootstrapMode} bootstrap`
        : `best available ${bootstrapMode} fallback`,
  };
}
/**
 * Build the runtime failover order for `smithers ask`.
 *
 * Default selection is Codex-first at the credential level: ambient auth,
 * every registered Codex/OpenAI account, then the usable non-Codex agents.
 * An explicit `--agent` remains a hard override and produces one attempt only.
 *
 * @param {AgentAvailability[]} detectedAgents
 * @param {AskOptions} options
 * @param {Account[]} codexAccounts
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {AskAttempt[]}
 */
export function buildAskAttemptPlan(detectedAgents, options, codexAccounts, env = process.env) {
  const ambientCodex = detectedAgents.find((agent) => agent.id === "codex");
  const accounts = codexAccounts.filter((account) =>
    account.provider === "codex"
      ? Boolean(account.configDir?.trim())
      : account.provider === "openai-api" && Boolean(account.apiKey?.trim()),
  );
  const agentsWithRegisteredCodex = withRegisteredCodexAvailability(detectedAgents, accounts[0]);
  if (options.agent) {
    const selection = selectAgent(agentsWithRegisteredCodex, options);
    return [
      {
        selection,
        ...(selection.availability.id === "codex" && !ambientCodex?.usable && accounts[0]
          ? { codexAccount: accounts[0] }
          : {}),
      },
    ];
  }
  /** @type {AskAttempt[]} */
  const attempts = [];
  if (ambientCodex?.usable && isSupportedAvailability(ambientCodex)) {
    const bootstrapMode = resolveBootstrapMode("codex", options.noMcp);
    attempts.push({
      selection: {
        availability: ambientCodex,
        bootstrapMode,
        selectionReason: `Codex is available; using Codex-first ${bootstrapMode} bootstrap`,
      },
    });
  }
  if (ambientCodex?.hasBinary && isSupportedAvailability(ambientCodex)) {
    const seen = new Set();
    for (const account of accounts) {
      const key =
        account.provider === "codex" ? `codex:${account.configDir?.trim()}` : `openai-api:${account.apiKey?.trim()}`;
      const duplicatesAmbient =
        ambientCodex.usable &&
        (account.provider === "codex"
          ? account.configDir?.trim() === env.CODEX_HOME?.trim()
          : account.apiKey?.trim() === env.OPENAI_API_KEY?.trim());
      if (seen.has(key) || duplicatesAmbient) continue;
      seen.add(key);
      const bootstrapMode = resolveBootstrapMode("codex", options.noMcp);
      attempts.push({
        selection: {
          availability: {
            ...ambientCodex,
            usable: true,
            status: account.provider === "openai-api" ? "api-key" : "likely-subscription",
            score: account.provider === "openai-api" ? 3 : 4,
            hasAuthSignal: account.provider === "codex",
            hasApiKeySignal: account.provider === "openai-api",
            unusableReasons: [],
            reason: `registered ${account.provider} account ${account.label}`,
          },
          bootstrapMode,
          selectionReason: `registered ${account.provider} account ${account.label}; Codex-first ${bootstrapMode} bootstrap`,
        },
        codexAccount: account,
      });
    }
  }
  const fallbacks = detectedAgents
    .filter(isSupportedAvailability)
    .filter((agent) => agent.id !== "codex" && agent.usable && !agent.deprecated)
    .sort((left, right) => compareAgents(left, right, options.noMcp));
  for (const availability of fallbacks) {
    const bootstrapMode = resolveBootstrapMode(availability.id, options.noMcp);
    attempts.push({
      selection: {
        availability,
        bootstrapMode,
        selectionReason: `Codex attempts exhausted; using ${availability.id} ${bootstrapMode} fallback`,
      },
    });
  }
  if (attempts.length === 0) {
    throw noUsableAgentError(detectedAgents);
  }
  return attempts;
}
/**
 * Run an attempt plan sequentially, stopping at the first success and
 * rethrowing the final failure if every candidate fails.
 *
 * @template T
 * @param {AskAttempt[]} attempts
 * @param {(attempt: AskAttempt) => Promise<T>} run
 * @returns {Promise<T>}
 */
export async function runAskAttempts(attempts, run) {
  let lastError;
  for (const attempt of attempts) {
    try {
      return await run(attempt);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new SmithersError("NO_USABLE_AGENTS", "No agent attempts were available for `smithers ask`.");
}
/**
 * @param {SmithersAgentContract} contract
 * @param {AskBootstrap} bootstrap
 */
function buildSystemPrompt(contract, bootstrap) {
  const lines = [
    "You are an autonomous AI agent operating inside the Smithers repository and control plane.",
    bootstrap.mode === "prompt-only"
      ? "MCP is disabled or unavailable for this run. Use the local Smithers repo and CLI directly when shell access is needed."
      : "Prefer the live Smithers MCP tools over shell commands whenever they can answer the request.",
    bootstrap.mode === "prompt-only"
      ? renderSmithersAgentPromptGuidance(contract, { available: false })
      : contract.promptGuidance,
    "If you need repository documentation, read local files in this checkout, starting with docs/llms-full.txt.",
    "Use `smithers` or `bun run src/index.js --help` to inspect the current CLI surface when you need shell fallbacks.",
    "Be concise and act directly.",
  ];
  return lines.join("\n\n");
}
/**
 * @param {AskSelection} selection
 * @param {AskBootstrap} bootstrap
 */
function formatBootstrap(selection, bootstrap) {
  const lines = [
    `agent: ${selection.availability.id}`,
    `selectionReason: ${selection.selectionReason}`,
    `bootstrapMode: ${bootstrap.mode}`,
    `toolSurface: ${bootstrap.toolSurface}`,
    `serverName: ${bootstrap.serverName}`,
  ];
  switch (bootstrap.mode) {
    case "mcp-config-file":
      lines.push("config:");
      lines.push(JSON.stringify(bootstrap.config, null, 2));
      break;
    case "mcp-config-inline":
      lines.push("configOverrides:");
      lines.push(...bootstrap.configOverrides.map((entry) => `- ${entry}`));
      break;
    case "mcp-allow-list":
      lines.push(`allowedMcpServerNames: ${bootstrap.allowedMcpServerNames.join(", ")}`);
      lines.push(`note: ${bootstrap.note}`);
      break;
    case "prompt-only":
      lines.push(`note: ${bootstrap.note}`);
      break;
  }
  return lines.join("\n");
}
/**
 * @param {AgentAvailability[]} agents
 * @param {AskOptions} options
 * @param {AskAgentId} [selectedAgentId]
 */
function formatAgentList(agents, options, selectedAgentId) {
  const supported = agents.filter(isSupportedAvailability);
  return supported
    .sort((left, right) => compareAgents(left, right, options.noMcp))
    .map((agent) => {
      const marker = agent.id === selectedAgentId ? "*" : " ";
      return `${marker} ${agent.id}  usable=${agent.usable ? "yes" : "no"}  status=${agent.status}  bootstrap=${resolveBootstrapMode(agent.id, options.noMcp)}`;
    })
    .join("\n");
}
/**
 * @param {AskSelection} selection
 * @param {AskBootstrap} bootstrap
 * @param {string} systemPrompt
 * @param {string} cwd
 * @returns {{ agent: BaseCliAgent; cleanup: () => void }}
 */
function buildAgent(selection, bootstrap, systemPrompt, cwd, codexAccount) {
  switch (selection.availability.id) {
    case "claude": {
      if (bootstrap.mode !== "mcp-config-file") {
        return {
          agent: new ClaudeCodeAgent({
            cwd,
            model: "claude-fable-5",
            systemPrompt,
            dangerouslySkipPermissions: true,
          }),
          cleanup() {},
        };
      }
      const mcpConfig = buildSmithersMcpConfigFile(bootstrap.toolSurface, bootstrap.serverName);
      return {
        agent: new ClaudeCodeAgent({
          cwd,
          model: "claude-fable-5",
          mcpConfig: [mcpConfig.path],
          strictMcpConfig: true,
          systemPrompt,
          dangerouslySkipPermissions: true,
        }),
        cleanup() {
          mcpConfig.cleanup();
        },
      };
    }
    case "kimi": {
      if (bootstrap.mode !== "mcp-config-file") {
        return {
          agent: new KimiAgent({
            cwd,
            model: "kimi-k2.6",
            systemPrompt,
          }),
          cleanup() {},
        };
      }
      const mcpConfig = buildSmithersMcpConfigFile(bootstrap.toolSurface, bootstrap.serverName);
      return {
        agent: new KimiAgent({
          cwd,
          model: "kimi-k2.6",
          mcpConfigFile: [mcpConfig.path],
          systemPrompt,
        }),
        cleanup() {
          mcpConfig.cleanup();
        },
      };
    }
    case "antigravity":
      return {
        agent: new AntigravityAgent({
          cwd,
          systemPrompt,
          dangerouslySkipPermissions: true,
        }),
        cleanup() {},
      };
    case "codex":
      return {
        agent: new CodexAgent({
          cwd,
          model: "gpt-5.6-luna",
          config: [
            ...(bootstrap.mode === "mcp-config-inline" ? bootstrap.configOverrides : []),
            "model_reasoning_effort=medium",
          ],
          systemPrompt,
          fullAuto: true,
          skipGitRepoCheck: true,
          ...(codexAccount?.configDir ? { configDir: codexAccount.configDir } : {}),
          ...(codexAccount?.apiKey ? { apiKey: codexAccount.apiKey } : {}),
        }),
        cleanup() {},
      };
    case "pi":
      return {
        agent: new PiAgent({
          cwd,
          provider: "openai",
          model: "gpt-5.6-luna",
          systemPrompt,
        }),
        cleanup() {},
      };
  }
}
/**
 * @param {string | undefined} question
 * @param {string} cwd
 * @param {AskOptions} [options]
 * @returns {Promise<void>}
 */
export async function ask(question, cwd, options = {}) {
  const detectedAgents = detectAvailableAgents(process.env, { cwd });
  const codexAccounts = registeredCodexAccounts(process.env);
  const agents = withRegisteredCodexAvailability(detectedAgents, codexAccounts[0]);
  if (options.listAgents) {
    let selectedAgentId;
    try {
      selectedAgentId = selectAgent(agents, options).availability.id;
    } catch {}
    process.stdout.write(`${formatAgentList(agents, options, selectedAgentId)}\n`);
    return;
  }
  const attempts = buildAskAttemptPlan(detectedAgents, options, codexAccounts);
  const selection = attempts[0].selection;
  const toolSurface = options.toolSurface ?? "semantic";
  const launchSpec = buildSmithersMcpLaunchSpec(toolSurface);
  const transport = new StdioClientTransport({
    command: launchSpec.command,
    args: launchSpec.args,
    cwd,
    stderr: "pipe",
  });
  const client = new Client({
    name: "smithers-ask-contract-probe",
    version: "1.0.0",
  });
  let tools;
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    tools = listed.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
    }));
  } catch (error) {
    throw new SmithersError(
      "ASK_BOOTSTRAP_FAILED",
      `Failed to probe the live Smithers MCP tools: ${error?.message ?? String(error)}`,
      {
        cwd,
        toolSurface,
        command: launchSpec.command,
        args: launchSpec.args,
      },
    );
  } finally {
    try {
      await client.close();
    } catch {}
    try {
      await transport.close();
    } catch {}
  }
  const contract = createSmithersAgentContract({
    toolSurface,
    serverName: DEFAULT_SERVER_NAME,
    tools,
  });
  const bootstrap = buildBootstrap(selection, toolSurface);
  const systemPrompt = buildSystemPrompt(contract, bootstrap);
  if (options.dumpPrompt || options.printBootstrap) {
    const sections = [];
    if (options.printBootstrap) {
      sections.push("[bootstrap]");
      sections.push(formatBootstrap(selection, bootstrap));
    }
    if (options.dumpPrompt) {
      sections.push("[system-prompt]");
      sections.push(systemPrompt);
    }
    process.stdout.write(`${sections.join("\n\n")}\n`);
    return;
  }
  if (!question?.trim()) {
    throw new SmithersError(
      "INVALID_ARGUMENT",
      "A question is required unless you use --list-agents, --dump-prompt, or --print-bootstrap.",
    );
  }
  await runAskAttempts(attempts, async (attempt) => {
    const attemptBootstrap = buildBootstrap(attempt.selection, toolSurface);
    const attemptSystemPrompt = buildSystemPrompt(contract, attemptBootstrap);
    const { agent, cleanup } = buildAgent(
      attempt.selection,
      attemptBootstrap,
      attemptSystemPrompt,
      cwd,
      attempt.codexAccount,
    );
    try {
      await agent.generate({
        prompt: question,
        onStdout: (chunk) => process.stdout.write(chunk),
      });
      process.stdout.write("\n");
    } finally {
      cleanup();
    }
  });
}
