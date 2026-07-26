export type CancelResult = {
  runId: string;
  status: "cancelling" | "cancelled" | "already-terminal" | "not-found";
  won: boolean;
  terminalStatus?: string;
  repaired: boolean;
};
