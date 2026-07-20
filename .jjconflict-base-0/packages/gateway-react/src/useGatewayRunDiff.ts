import { useGatewayRpc } from "./useGatewayRpc.ts";

export function useGatewayRunDiff(params: { runId: string | undefined }) {
  return useGatewayRpc("getRunDiff", { runId: params.runId ?? "" }, { enabled: Boolean(params.runId) });
}
