export type Tool<Input = unknown, Output = unknown> = {
  description?: string;
  inputSchema: unknown;
  execute?: (input: Input, options?: { abortSignal?: AbortSignal }) => Output | Promise<Output>;
};

/**
 * Type alias for an AI SDK tool produced from an OpenAPI operation.
 * Re-exported here so JSDoc files can reference a stable name without
 * reaching into the `ai` package directly.
 */
export type OpenApiTool = Tool;
