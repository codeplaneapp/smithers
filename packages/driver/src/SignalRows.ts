export type SignalRow<Payload = unknown> = {
  payload: Payload;
  signalName: string;
  seq: number;
  correlationId?: string;
  receivedAtMs: number;
};
export type SignalRowsOptions = { correlationId?: string };
export type SignalRowsReader = {
  (signalName: string, options?: SignalRowsOptions): Array<SignalRow<unknown>>;
};
