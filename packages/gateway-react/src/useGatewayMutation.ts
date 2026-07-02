import { useCallback, useState } from "react";
import { useGatewayActions } from "./useGatewayActions.ts";
import { useSmithersCollections } from "./useSmithersCollections.ts";

type MutationState<TVariables, TData> = {
  mutate: (variables: TVariables) => Promise<TData>;
  mutateSafe: (variables: TVariables) => Promise<TData | undefined>;
  isLoading: boolean;
  error: Error | undefined;
};

type MutationOptions = {
  invalidate?: readonly unknown[];
};

export function useGatewayMutation<TVariables = Record<string, unknown>, TData = unknown>(
  method: string,
  _options: MutationOptions = {},
): MutationState<TVariables, TData> {
  const actions = useGatewayActions();
  const { collections } = useSmithersCollections();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | undefined>(undefined);

  const mutate = useCallback(async (variables: TVariables) => {
    setIsLoading(true);
    setError(undefined);
    try {
      let data: unknown;
      switch (method) {
        case "launchRun":
          data = await actions.launchRun(variables as Parameters<typeof actions.launchRun>[0]);
          break;
        case "resumeRun":
          data = await actions.resumeRun(variables as Parameters<typeof actions.resumeRun>[0]);
          break;
        case "cancelRun":
          data = await actions.cancelRun(variables as Parameters<typeof actions.cancelRun>[0]);
          break;
        case "hijackRun":
          data = await actions.hijackRun(variables as Parameters<typeof actions.hijackRun>[0]);
          break;
        case "rewindRun":
          data = await actions.rewindRun(variables as Parameters<typeof actions.rewindRun>[0]);
          break;
        case "submitApproval":
          data = await actions.submitApproval(variables as Parameters<typeof actions.submitApproval>[0]);
          break;
        case "submitSignal":
          data = await actions.submitSignal(variables as Parameters<typeof actions.submitSignal>[0]);
          break;
        case "cronCreate":
          data = await actions.cronCreate(variables as Parameters<typeof actions.cronCreate>[0]);
          break;
        case "cronDelete":
          data = await actions.cronDelete(variables as Parameters<typeof actions.cronDelete>[0]);
          break;
        case "cronRun":
          data = await actions.cronRun(variables as Parameters<typeof actions.cronRun>[0]);
          break;
        case "createTicket":
          data = await actions.createTicket(variables as Parameters<typeof actions.createTicket>[0]);
          break;
        case "updateTicket":
          data = await actions.updateTicket(variables as Parameters<typeof actions.updateTicket>[0]);
          break;
        case "deleteTicket":
          data = await actions.deleteTicket(variables as Parameters<typeof actions.deleteTicket>[0]);
          break;
        default:
          throw new Error(`Unsupported Gateway domain mutation: ${method}`);
      }
      await collections.invalidate();
      return data as TData;
    } catch (cause) {
      const next = cause instanceof Error ? cause : new Error(String(cause));
      setError(next);
      throw next;
    } finally {
      setIsLoading(false);
    }
  }, [actions, collections, method]);

  const mutateSafe = useCallback(async (variables: TVariables) => {
    try {
      return await mutate(variables);
    } catch {
      return undefined;
    }
  }, [mutate]);

  return { mutate, mutateSafe, isLoading, error };
}
