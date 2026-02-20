export type AgentLike = {
  id?: string;
  tools?: Record<string, any>;
  generate: (args: {
    options?: any;
    abortSignal?: AbortSignal;
    prompt: string;
    timeout?: { totalMs: number } | undefined;
    onStdout?: (text: string) => void;
    onStderr?: (text: string) => void;
    outputSchema?: import("zod").ZodObject<any>;
  }) => Promise<any>;
  [key: string]: any;
};
