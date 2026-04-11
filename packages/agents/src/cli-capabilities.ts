import {
  hashCapabilityRegistry,
  normalizeCapabilityRegistry,
  type AgentCapabilityRegistry,
} from "./capability-registry";
import { createClaudeCodeCapabilityRegistry } from "./ClaudeCodeAgent";
import { createCodexCapabilityRegistry } from "./CodexAgent";
import { createGeminiCapabilityRegistry } from "./GeminiAgent";
import { createKimiCapabilityRegistry } from "./KimiAgent";
import { createPiCapabilityRegistry } from "./PiAgent";

export type CliAgentCapabilityAdapterId =
  | "claude"
  | "codex"
  | "gemini"
  | "kimi"
  | "pi";

type CliAgentCapabilityAdapter = {
  id: CliAgentCapabilityAdapterId;
  binary: string;
  buildRegistry: () => AgentCapabilityRegistry;
};

type CapabilityIssue = {
  code: string;
  message: string;
  severity: "error" | "warning";
};

export type CliAgentCapabilityReportEntry = {
  id: CliAgentCapabilityAdapterId;
  binary: string;
  fingerprint: string;
  capabilities: AgentCapabilityRegistry;
};

export type CliAgentCapabilityDoctorEntry = CliAgentCapabilityReportEntry & {
  ok: boolean;
  issues: CapabilityIssue[];
};

export type CliAgentCapabilityDoctorReport = {
  ok: boolean;
  issueCount: number;
  agents: CliAgentCapabilityDoctorEntry[];
};

const CLI_AGENT_CAPABILITY_ADAPTERS: readonly CliAgentCapabilityAdapter[] = [
  {
    id: "claude",
    binary: "claude",
    buildRegistry: () => createClaudeCodeCapabilityRegistry(),
  },
  {
    id: "codex",
    binary: "codex",
    buildRegistry: () => createCodexCapabilityRegistry(),
  },
  {
    id: "gemini",
    binary: "gemini",
    buildRegistry: () => createGeminiCapabilityRegistry(),
  },
  {
    id: "kimi",
    binary: "kimi",
    buildRegistry: () => createKimiCapabilityRegistry(),
  },
  {
    id: "pi",
    binary: "pi",
    buildRegistry: () => createPiCapabilityRegistry(),
  },
] as const;

function diagnoseCapabilityRegistry(
  registry: AgentCapabilityRegistry,
): CapabilityIssue[] {
  const issues: CapabilityIssue[] = [];

  if (registry.version !== 1) {
    issues.push({
      code: "registry-version",
      message: `Expected capability registry version 1, received ${registry.version}.`,
      severity: "error",
    });
  }

  if (!registry.skills.supportsSkills) {
    if (registry.skills.installMode) {
      issues.push({
        code: "skills-install-mode-without-support",
        message: "Skills install mode is set even though the adapter declares no skills support.",
        severity: "error",
      });
    }
    if (registry.skills.smithersSkillIds.length > 0) {
      issues.push({
        code: "skills-listed-without-support",
        message: "Smithers skills are listed even though the adapter declares no skills support.",
        severity: "error",
      });
    }
  } else if (!registry.skills.installMode) {
    issues.push({
      code: "missing-skills-install-mode",
      message: "Adapters that support skills must declare an install mode.",
      severity: "error",
    });
  }

  if (!registry.humanInteraction.supportsUiRequests) {
    if (registry.humanInteraction.methods.length > 0) {
      issues.push({
        code: "ui-methods-without-support",
        message: "UI request methods are listed even though the adapter declares no UI request support.",
        severity: "error",
      });
    }
  } else if (registry.humanInteraction.methods.length === 0) {
    issues.push({
      code: "missing-ui-methods",
      message: "Adapters that support UI requests must declare at least one method.",
      severity: "error",
    });
  }

  if (registry.mcp.bootstrap === "unsupported") {
    if (registry.mcp.supportsProjectScope || registry.mcp.supportsUserScope) {
      issues.push({
        code: "unsupported-mcp-with-scope",
        message: "Unsupported MCP adapters cannot advertise project or user scope support.",
        severity: "error",
      });
    }
  } else if (!registry.mcp.supportsProjectScope && !registry.mcp.supportsUserScope) {
    issues.push({
      code: "mcp-bootstrap-without-scope",
      message: "Supported MCP adapters should advertise at least one supported scope.",
      severity: "warning",
    });
  }

  return issues;
}

export function getCliAgentCapabilityReport(): CliAgentCapabilityReportEntry[] {
  return CLI_AGENT_CAPABILITY_ADAPTERS.map((adapter) => {
    const capabilities = normalizeCapabilityRegistry(adapter.buildRegistry());
    if (!capabilities) {
      throw new Error(`Capability registry missing for adapter ${adapter.id}`);
    }
    return {
      id: adapter.id,
      binary: adapter.binary,
      fingerprint: hashCapabilityRegistry(capabilities),
      capabilities,
    };
  });
}

export function getCliAgentCapabilityDoctorReport(): CliAgentCapabilityDoctorReport {
  const agents = getCliAgentCapabilityReport().map((entry) => {
    const issues = diagnoseCapabilityRegistry(entry.capabilities);
    return {
      ...entry,
      ok: issues.length === 0,
      issues,
    };
  });

  const issueCount = agents.reduce((count, entry) => count + entry.issues.length, 0);
  return {
    ok: issueCount === 0,
    issueCount,
    agents,
  };
}

export function formatCliAgentCapabilityDoctorReport(
  report: CliAgentCapabilityDoctorReport,
): string {
  if (report.ok) {
    return `All ${report.agents.length} built-in CLI agent capability registries passed.`;
  }

  const lines = [
    `Capability issues found: ${report.issueCount}`,
  ];

  for (const agent of report.agents) {
    if (agent.issues.length === 0) {
      continue;
    }
    lines.push(`${agent.id} (${agent.capabilities.engine})`);
    for (const issue of agent.issues) {
      lines.push(`  - [${issue.severity}] ${issue.code}: ${issue.message}`);
    }
  }

  return lines.join("\n");
}
