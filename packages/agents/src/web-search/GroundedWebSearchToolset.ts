import type { Tool } from "../Tool";

export type GroundedWebSearchToolset = {
  tools: Record<"grounded_web_search", Tool>;
  toolNames: ["grounded_web_search"];
};
