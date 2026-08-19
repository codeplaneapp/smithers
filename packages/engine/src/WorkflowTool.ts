type Tool<Input = unknown, Output = unknown> = {
  description?: string;
  inputSchema: unknown;
  execute?: (input: Input, options?: { abortSignal?: AbortSignal }) => Output | Promise<Output>;
};

export type WorkflowToolInput<Schema> = Schema extends { input: infer Input } ? Input : Record<string, never>;
export type WorkflowTool<Input = Record<string, never>, Output = unknown> = Tool<Input, Output>;
