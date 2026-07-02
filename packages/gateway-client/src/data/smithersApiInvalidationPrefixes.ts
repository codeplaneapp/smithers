import type { QueryKey } from "@tanstack/react-query";

export function smithersApiInvalidationPrefixes(name: string): QueryKey[] {
  switch (name) {
    case "runs":
      return [["smithers", "runs"]];
    case "run_events":
    case "events":
      return [["smithers", "events"], ["smithers", "runTree"], ["smithers", "runs"]];
    case "node_outputs":
    case "nodes":
    case "runTree":
      return [["smithers", "runTree"], ["smithers", "nodes"]];
    case "approvals":
      return [["smithers", "approvals"], ["smithers", "runs"], ["smithers", "runTree"]];
    case "workflows":
      return [["smithers", "workflows"]];
    case "docs":
      return [["smithers", "docs"]];
    case "prompts":
      return [["smithers", "prompts"]];
    case "scores":
      return [["smithers", "scores"]];
    case "tickets":
      return [["smithers", "tickets"], ["smithers", "docs"]];
    case "memoryFacts":
    case "memory_facts":
      return [["smithers", "memoryFacts"]];
    case "crons":
      return [["smithers", "crons"], ["smithers", "runs"]];
    default:
      return [["smithers"]];
  }
}
