import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AmpAgent,
  AntigravityAgent,
  ClaudeCodeAgent,
  CodexAgent,
  ForgeAgent,
  GeminiAgent,
  KimiAgent,
  OpenCodeAgent,
  PiAgent,
  VibeAgent,
} from "../src/index.js";
import { getCliAgentCapabilityReport } from "../src/cli-capabilities/getCliAgentCapabilityReport.js";
import { getCliAgentCapabilityDoctorReport } from "../src/cli-capabilities/getCliAgentCapabilityDoctorReport.js";
import { CLI_AGENT_SURFACE_MANIFEST } from "../src/cli-surface/index.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function makeDoctorEntry(overrides = {}) {
  const base = getCliAgentCapabilityReport().find((entry) => entry.id === "opencode");
  return {
    ...base,
    capabilities: structuredClone(base.capabilities),
    surface: structuredClone(base.surface),
    ...overrides,
  };
}

function issueCodes(report) {
  return report.agents.flatMap((entry) => entry.issues.map((issue) => issue.code));
}

function collectEmittedCommandTokens(spec, manifest) {
  const declared = new Set(manifest.emittedFlags);
  return new Set(
    spec.args.filter((arg) => {
      if (arg === "--") return true;
      if (arg.startsWith("-")) return true;
      return declared.has(arg);
    }),
  );
}

function commonParams(options = {}) {
  return {
    prompt: "prompt",
    systemPrompt: "system",
    cwd: REPO_ROOT,
    options,
  };
}

async function buildDeclaredSurfaceCommands() {
  const kimiConfigDir = `${tmpdir()}/smithers-kimi-surface-test`;
  mkdirSync(kimiConfigDir, { recursive: true });
  const cases = [
    {
      id: "amp",
      agent: new AmpAgent({
        dangerouslyAllowAll: true,
        model: "m",
        visibility: "private",
        mcpConfig: "mcp.json",
        settingsFile: "settings.json",
        logLevel: "debug",
        logFile: "amp.log",
      }),
      params: commonParams({ onEvent: () => undefined }),
    },
    {
      id: "antigravity",
      agent: new AntigravityAgent({
        model: "m",
        sandbox: true,
        dangerouslySkipPermissions: true,
        allowedMcpServerNames: ["server"],
        allowedTools: ["tool"],
        includeDirectories: ["src"],
        continue: true,
        conversation: "conv",
        geminiDir: "gemini-dir",
      }),
      params: commonParams(),
    },
    {
      id: "claude",
      agent: new ClaudeCodeAgent({
        addDir: ["src"],
        agent: "coder",
        agents: { coder: { description: "Coder", prompt: "Do work", tools: ["Read"] } },
        allowDangerouslySkipPermissions: true,
        dangerouslySkipPermissions: true,
        allowedTools: ["Read"],
        appendSystemPrompt: "append",
        betas: ["beta"],
        chrome: true,
        noChrome: true,
        continue: true,
        debug: true,
        debugFile: "debug.log",
        disableSlashCommands: true,
        disallowedTools: ["Bash"],
        fallbackModel: "fallback",
        file: ["README.md"],
        forkSession: true,
        fromPr: "1",
        ide: true,
        includePartialMessages: true,
        inputFormat: "stream-json",
        jsonSchema: "schema.json",
        maxBudgetUsd: "1",
        mcpConfig: ["mcp.json"],
        mcpDebug: true,
        model: "m",
        noSessionPersistence: true,
        permissionMode: "acceptEdits",
        pluginDir: ["plugins"],
        replayUserMessages: true,
        resume: "session",
        sessionId: "session-id",
        settingSources: "user",
        settings: "settings.json",
        strictMcpConfig: true,
        systemPrompt: "system",
        tools: ["Read"],
        verbose: true,
      }),
      params: commonParams(),
    },
    {
      id: "codex",
      agent: new CodexAgent({
        config: { model: "m" },
        enable: ["web_search"],
        disable: ["image_generation"],
        image: ["image.png"],
        model: "m",
        oss: true,
        localProvider: "ollama",
        sandbox: "workspace-write",
        profile: "default",
        dangerouslyBypassApprovalsAndSandbox: true,
        cd: REPO_ROOT,
        skipGitRepoCheck: true,
        addDir: ["src"],
        outputSchema: "schema.json",
        color: "never",
        outputLastMessage: "last.txt",
      }),
      params: commonParams(),
    },
    {
      id: "codex",
      agent: new CodexAgent({
        fullAuto: true,
        outputLastMessage: "last.txt",
      }),
      params: commonParams(),
    },
    {
      id: "forge",
      agent: new ForgeAgent({
        model: "m",
        provider: "openai",
        agent: "coder",
        conversationId: "conv",
        sandbox: "workspace-write",
        restricted: true,
        verbose: true,
        workflow: "workflow",
        event: "event",
        conversation: "conversation.json",
        directory: REPO_ROOT,
      }),
      params: commonParams(),
    },
    {
      id: "gemini",
      agent: new GeminiAgent({
        debug: true,
        model: "m",
        sandbox: true,
        approvalMode: "yolo",
        experimentalAcp: true,
        allowedMcpServerNames: ["server"],
        allowedTools: ["tool"],
        extensions: ["ext"],
        listExtensions: true,
        resume: "session",
        listSessions: true,
        deleteSession: "session",
        includeDirectories: ["src"],
        screenReader: true,
      }),
      params: commonParams(),
    },
    {
      id: "gemini",
      agent: new GeminiAgent({
        yolo: true,
      }),
      params: commonParams(),
    },
    {
      id: "kimi",
      agent: new KimiAgent({
        configDir: kimiConfigDir,
        outputFormat: "text",
        finalMessageOnly: true,
        workDir: REPO_ROOT,
        session: "session",
        continue: true,
        model: "m",
        thinking: false,
        quiet: true,
        agent: "coder",
        agentFile: "agent.toml",
        mcpConfigFile: ["mcp-file.json"],
        mcpConfig: ["mcp.json"],
        skillsDir: "skills",
        maxStepsPerTurn: 1,
        maxRetriesPerStep: 1,
        maxRalphIterations: 1,
        verbose: true,
        debug: true,
      }),
      params: commonParams(),
    },
    {
      id: "kimi",
      agent: new KimiAgent({
        configDir: kimiConfigDir,
        thinking: true,
      }),
      params: commonParams(),
    },
    {
      id: "opencode",
      agent: new OpenCodeAgent({
        model: "m",
        agentName: "coder",
        attachFiles: ["README.md"],
        continueSession: true,
        sessionId: "session",
        variant: "fast",
      }),
      params: commonParams(),
    },
    {
      id: "opencode",
      agent: new OpenCodeAgent({
        continueSession: true,
      }),
      params: commonParams(),
    },
    {
      id: "pi",
      agent: new PiAgent({
        provider: "openai",
        model: "m",
        apiKey: "key",
        systemPrompt: "system",
        appendSystemPrompt: "append",
        continue: true,
        resume: true,
        session: "session",
        sessionDir: "sessions",
        noSession: true,
        models: ["a", "b"],
        listModels: true,
        export: "json",
        tools: ["read"],
        noTools: true,
        extension: ["ext"],
        noExtensions: true,
        skill: ["skill"],
        noSkills: true,
        promptTemplate: ["template"],
        noPromptTemplates: true,
        theme: ["theme"],
        noThemes: true,
        thinking: "medium",
        verbose: true,
        files: ["README.md"],
      }),
      params: commonParams({ onEvent: () => undefined }),
    },
    {
      id: "pi",
      agent: new PiAgent({
        noSession: true,
      }),
      params: commonParams(),
    },
    {
      id: "vibe",
      agent: new VibeAgent({
        sessionId: "session",
        agent: "coder",
        maxTurns: 2,
        maxPrice: 1,
        maxTokens: 100,
        enabledTools: ["read"],
      }),
      params: commonParams(),
    },
    {
      id: "vibe",
      agent: new VibeAgent({
        continueSession: true,
      }),
      params: commonParams(),
    },
  ];

  const entriesById = new Map();
  for (const item of cases) {
    const manifest = CLI_AGENT_SURFACE_MANIFEST.find((entry) => entry.id === item.id);
    const spec = await item.agent.buildCommand(item.params);
    const entry = entriesById.get(item.id) ?? {
      id: item.id,
      command: spec.command,
      emitted: new Set(),
    };
    for (const token of collectEmittedCommandTokens(spec, manifest)) {
      entry.emitted.add(token);
    }
    entriesById.set(item.id, entry);
  }
  return [...entriesById.values()];
}

describe("getCliAgentCapabilityReport", () => {
  test("includes opencode in capability discovery", () => {
    const report = getCliAgentCapabilityReport();
    expect(report.map((entry) => entry.id)).toContain("opencode");
  });

  test("covers every CLI surface manifest entry", () => {
    const report = getCliAgentCapabilityReport();
    expect(report.map((entry) => entry.id).sort()).toEqual(
      CLI_AGENT_SURFACE_MANIFEST.map((entry) => entry.id).sort(),
    );
    for (const entry of report) {
      expect(entry.surface.binary).toBe(entry.binary);
      expect(entry.surface.packageExport).toBeTruthy();
      expect(entry.surface.defaultOutputFormat).toBeTruthy();
    }
  });

  test("surface doctor rejects unsupported emitted flags", () => {
    const report = getCliAgentCapabilityDoctorReport();
    expect(report.ok).toBe(true);
    expect(report.issueCount).toBe(0);

    for (const entry of report.agents) {
      const emitted = new Set(entry.surface.emittedFlags);
      for (const unsupported of entry.surface.unsupportedFlags) {
        expect(emitted.has(unsupported.flag)).toBe(false);
      }
    }
  });

  test("surface doctor reports malformed capability registry branches", () => {
    const entry = makeDoctorEntry({
      capabilities: {
        ...makeDoctorEntry().capabilities,
        version: 2,
        skills: {
          supportsSkills: false,
          installMode: "copy",
          smithersSkillIds: ["skill"],
        },
        humanInteraction: {
          supportsUiRequests: false,
          methods: ["extension-ui"],
        },
        mcp: {
          bootstrap: "unsupported",
          supportsProjectScope: true,
          supportsUserScope: false,
        },
      },
    });

    const report = getCliAgentCapabilityDoctorReport([entry]);

    expect(report.ok).toBe(false);
    expect(report.issueCount).toBe(5);
    expect(issueCodes(report)).toEqual([
      "registry-version",
      "skills-install-mode-without-support",
      "skills-listed-without-support",
      "ui-methods-without-support",
      "unsupported-mcp-with-scope",
    ]);
  });

  test("surface doctor reports missing support details", () => {
    const entry = makeDoctorEntry({
      capabilities: {
        ...makeDoctorEntry().capabilities,
        skills: {
          supportsSkills: true,
          installMode: null,
          smithersSkillIds: [],
        },
        humanInteraction: {
          supportsUiRequests: true,
          methods: [],
        },
        mcp: {
          bootstrap: "config-file",
          supportsProjectScope: false,
          supportsUserScope: false,
        },
      },
    });

    const report = getCliAgentCapabilityDoctorReport([entry]);

    expect(report.ok).toBe(false);
    expect(report.issueCount).toBe(3);
    expect(issueCodes(report)).toEqual([
      "missing-skills-install-mode",
      "missing-ui-methods",
      "mcp-bootstrap-without-scope",
    ]);
  });

  test("surface doctor reports surface manifest contract failures", () => {
    const entry = makeDoctorEntry({
      binary: "actual-binary",
      surface: {
        ...makeDoctorEntry().surface,
        binary: "manifest-binary",
        docsUrls: [],
        emittedFlags: ["--bad-resume"],
        unsupportedFlags: [{ flag: "--bad-resume", replacement: "--good-resume", reason: "test" }],
        resume: { kind: "flag", emitted: [], notes: "test" },
      },
    });

    const report = getCliAgentCapabilityDoctorReport([entry]);

    expect(report.ok).toBe(false);
    expect(report.issueCount).toBe(4);
    expect(issueCodes(report)).toEqual([
      "unsupported-flag-emitted",
      "surface-binary-mismatch",
      "missing-surface-docs",
      "missing-resume-emission",
    ]);
  });

  test("manifest emittedFlags match real buildCommand output", async () => {
    const commands = await buildDeclaredSurfaceCommands();

    for (const { id, command, emitted } of commands) {
      const manifest = CLI_AGENT_SURFACE_MANIFEST.find((entry) => entry.id === id);
      expect(manifest, id).toBeTruthy();
      expect(command, id).toBe(manifest.binary);
      expect([...emitted].sort(), id).toEqual([...manifest.emittedFlags].sort());
    }
  });

  test("Antigravity docs and manifest describe the current agy flag mapping", () => {
    const antigravity = CLI_AGENT_SURFACE_MANIFEST.find((entry) => entry.id === "antigravity");
    expect(antigravity).toBeTruthy();
    expect(antigravity.emittedFlags).toContain("-p");
    expect(antigravity.emittedFlags).toContain("--add-dir");
    expect(antigravity.emittedFlags).toContain("--conversation");
    expect(antigravity.unsupportedFlags.map((entry) => entry.flag)).toEqual(
      expect.arrayContaining(["--output-format", "--include-directories", "--resume", "--screen-reader", "--debug"]),
    );

    const docs = readFileSync(resolve(REPO_ROOT, "docs/integrations/cli-agents.mdx"), "utf8");
    expect(docs).toContain("| `includeDirectories` | `--add-dir` |");
    expect(docs).toContain("| `conversation` / `resume` | `--conversation <id>` |");
    expect(docs).toContain("does not emit `--output-format`");
  });
});
