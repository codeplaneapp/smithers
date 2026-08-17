import type { AgentToolDescriptor } from "./AgentToolDescriptor";

export type AgentCapabilityRegistry = {
  version: 1;
  engine:
    | "claude-code"
    | "codex"
    | "cursor"
    | "antigravity"
    | "gemini"
    | "kimi"
    | "grok"
    | "pi"
    | "omp"
    | "amp"
    | "forge"
    | "hermes"
    | "opencode"
    | "openclaw"
    | "pool"
    | "vibe";
  runtimeTools: Record<string, AgentToolDescriptor>;
  mcp: {
    bootstrap: "inline-config" | "project-config" | "allow-list" | "unsupported";
    supportsProjectScope: boolean;
    supportsUserScope: boolean;
  };
  skills: {
    supportsSkills: boolean;
    installMode?: "files" | "dir" | "plugin";
    smithersSkillIds: string[];
  };
  humanInteraction: {
    supportsUiRequests: boolean;
    methods: string[];
  };
  fileChanges: {
    /** Can this engine identify file-mutating tool calls at all? */
    supportsFileChanges: boolean;
    /** Can it produce (report or reconstruct) full diff content? */
    supportsUnifiedDiff: boolean;
  };
  builtIns: string[];
};
