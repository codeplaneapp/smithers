export type DocumentParsingToolset = {
  tools: Record<string, import("../Tool").Tool>;
  toolNames: string[];
};
