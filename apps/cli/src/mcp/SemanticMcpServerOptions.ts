import type { SemanticToolName } from "./SemanticToolName.ts";

export type SemanticMcpServerOptions = {
    name?: string;
    version?: string;
    /**
     * Semantic tool names to expose. An empty allowlist intentionally exposes no semantic tools.
     */
    allowedTools?: readonly SemanticToolName[];
    readOnly?: boolean;
};
