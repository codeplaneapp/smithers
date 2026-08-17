import type { Tool } from "ai";

export type WorkflowToolInput<Schema> = Schema extends { input: infer Input } ? Input : Record<string, never>;
export type WorkflowTool<Input = Record<string, never>, Output = unknown> = Tool<Input, Output>;
