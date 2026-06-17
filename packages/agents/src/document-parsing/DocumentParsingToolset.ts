export type DocumentParsingToolset = {
  tools: Record<string, import("ai").Tool>;
  toolNames: string[];
};
