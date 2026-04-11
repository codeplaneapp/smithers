import { Context, Effect, Layer } from "effect";

export type ApprovalResolution = {
  readonly approved: boolean;
  readonly note?: string;
  readonly decidedBy?: string;
  readonly optionKey?: string;
  readonly payload?: unknown;
};

export type TimerRequest = {
  readonly nodeId: string;
  readonly resumeAtMs: number;
};

export type ContinueAsNewTransition = {
  readonly reason: "explicit" | "loop-threshold" | "driver";
  readonly iteration?: number;
  readonly statePayload?: unknown;
  readonly stateJson?: string;
  readonly newRunId?: string;
  readonly carriedStateBytes?: number;
  readonly ancestryDepth?: number;
};

export type DurablePrimitivesService = {
  readonly resolveApproval: (
    nodeId: string,
    resolution: ApprovalResolution,
  ) => Effect.Effect<ApprovalResolution>;
  readonly receiveEvent: (
    eventName: string,
    payload: unknown,
  ) => Effect.Effect<{ readonly eventName: string; readonly payload: unknown }>;
  readonly createTimer: (request: TimerRequest) => Effect.Effect<TimerRequest>;
  readonly continueAsNew: (
    transition: ContinueAsNewTransition,
  ) => Effect.Effect<ContinueAsNewTransition>;
};

export class DurablePrimitives extends Context.Tag("DurablePrimitives")<
  DurablePrimitives,
  DurablePrimitivesService
>() {}

export const DurablePrimitivesLive = Layer.succeed(DurablePrimitives, {
  resolveApproval: (_nodeId, resolution) => Effect.succeed(resolution),
  receiveEvent: (eventName, payload) => Effect.succeed({ eventName, payload }),
  createTimer: (request) => Effect.succeed(request),
  continueAsNew: (transition) => Effect.succeed(transition),
});
