export type AgentToolDescriptor = {
  description?: string;
  source?: "builtin" | "mcp" | "extension" | "skill" | "runtime";
};

export type AgentCapabilityRegistry = {
  version: 1;
  engine: "claude-code" | "codex" | "gemini" | "kimi" | "pi" | "amp";
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
  builtIns: string[];
};
