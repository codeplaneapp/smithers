import type { GatewayRunNode } from "@smithers-orchestrator/gateway-client";
import type { SelectOption } from "@opentui/core";

const RUNNING_STATUSES = new Set(["running", "active"]);

export function runningNodes(nodes: readonly GatewayRunNode[]): GatewayRunNode[] {
  return nodes.filter((n) => RUNNING_STATUSES.has(n.status ?? ""));
}

export function nodeSelectOption(node: GatewayRunNode): SelectOption {
  return {
    name: node.name ?? node.id,
    description: `id: ${node.id}  kind: ${node.kind ?? "task"}  status: ${node.status ?? "unknown"}`,
    value: node.id,
  };
}

export function hijackExitMessage(code: number | null): string {
  if (code === null) return "exited (error)";
  if (code === 0) return "exited ok";
  return `exited (code ${code})`;
}
