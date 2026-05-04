import { useMemo } from "react";
import { useSmithersGateway } from "./useSmithersGateway.ts";

export function useGatewayActions() {
  const client = useSmithersGateway();
  return useMemo(
    () => ({
      launchRun: client.launchRun.bind(client),
      resumeRun: client.resumeRun.bind(client),
      cancelRun: client.cancelRun.bind(client),
      hijackRun: client.hijackRun.bind(client),
      rewindRun: client.rewindRun.bind(client),
      submitApproval: client.submitApproval.bind(client),
      submitSignal: client.submitSignal.bind(client),
      cronCreate: client.cronCreate.bind(client),
      cronDelete: client.cronDelete.bind(client),
      cronRun: client.cronRun.bind(client),
    }),
    [client],
  );
}
