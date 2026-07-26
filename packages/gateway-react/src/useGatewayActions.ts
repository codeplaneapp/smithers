import { useMemo } from "react";
import { useSmithersCollections } from "./useSmithersCollections.ts";

function unwrap<T extends object>(result: {
  data: T;
  seq?: number;
  txid?: string;
}): T & { seq?: number; txid?: string } {
  return {
    ...result.data,
    ...(result.seq === undefined ? {} : { seq: result.seq }),
    ...(result.txid === undefined ? {} : { txid: result.txid }),
  };
}

export function useGatewayActions() {
  const { client } = useSmithersCollections();
  return useMemo(
    () => ({
      launchRun: async (...args: Parameters<typeof client.api.launchRun>) =>
        unwrap(await client.api.launchRun(...args)),
      resumeRun: async (...args: Parameters<typeof client.api.resumeRun>) =>
        unwrap(await client.api.resumeRun(...args)),
      cancelRun: async (...args: Parameters<typeof client.api.cancelRun>) =>
        unwrap(await client.api.cancelRun(...args)),
      hijackRun: async (...args: Parameters<typeof client.api.hijackRun>) =>
        unwrap(await client.api.hijackRun(...args)),
      rewindRun: async (...args: Parameters<typeof client.api.rewindRun>) =>
        unwrap(await client.api.rewindRun(...args)),
      submitApproval: async (...args: Parameters<typeof client.api.submitApproval>) =>
        unwrap(await client.api.submitApproval(...args)),
      submitSignal: async (...args: Parameters<typeof client.api.submitSignal>) =>
        unwrap(await client.api.submitSignal(...args)),
      cronCreate: async (...args: Parameters<typeof client.api.cronCreate>) =>
        unwrap(await client.api.cronCreate(...args)),
      cronDelete: async (...args: Parameters<typeof client.api.cronDelete>) =>
        unwrap(await client.api.cronDelete(...args)),
      cronRun: async (...args: Parameters<typeof client.api.cronRun>) => unwrap(await client.api.cronRun(...args)),
      createTicket: async (...args: Parameters<typeof client.api.createTicket>) =>
        unwrap(await client.api.createTicket(...args)),
      updateTicket: async (...args: Parameters<typeof client.api.updateTicket>) =>
        unwrap(await client.api.updateTicket(...args)),
      deleteTicket: async (...args: Parameters<typeof client.api.deleteTicket>) =>
        unwrap(await client.api.deleteTicket(...args)),
    }),
    [client],
  );
}
