/** Portable structural type for a tool created inside the runtime layer. */
export type DefinedRuntimeTool = {
  description?: string;
  inputSchema?: unknown;
  execute?: (args: unknown, options?: unknown) => Promise<unknown>;
  [key: string]: unknown;
  [key: symbol]: unknown;
};
