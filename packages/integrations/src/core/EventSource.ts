import type { Stream } from "effect";
import type { ExternalEvent } from "./ExternalEvent.ts";
import type { SmithersError } from "@smithers-orchestrator/errors/SmithersError";

/**
 * A process-wide source of external events. `events` is the (possibly
 * infinite) stream the IntegrationRuntime drains into the delivery pipeline.
 */
export type EventSource = {
  id: string;
  events: Stream.Stream<ExternalEvent, SmithersError>;
};

/**
 * The raw webhook request handed to a webhook source's `offer`: the
 * already-read raw body (needed for HMAC verification) plus headers.
 */
export type WebhookRequest = {
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
};

export type MakeWebhookSourceOptions = {
  id: string;
  /** Bounded queue capacity between ingress and delivery. @default 256 */
  capacity?: number;
  /** Signature check; return false to reject with `invalid-signature`. */
  verify?: (request: WebhookRequest) => boolean;
  /** Decode a verified request into one or more ExternalEvents. */
  decode: (request: WebhookRequest) => ExternalEvent | ExternalEvent[];
};

export type WebhookSource = {
  source: EventSource;
  /** Verify + decode + enqueue a webhook request; resolves with the accepted count. */
  offer: (
    request: WebhookRequest,
  ) => import("effect").Effect.Effect<{ accepted: number }, SmithersError>;
  shutdown: import("effect").Effect.Effect<void>;
};

export type PollResult = {
  events: ExternalEvent[];
  /** Next cursor to persist; omit/undefined to keep the current cursor. */
  cursor?: string | null;
};

export type MakePollingSourceOptions = {
  id: string;
  /** One poll turn: given the current cursor, fetch new events + next cursor. */
  poll: (
    cursor: string | null,
  ) => import("effect").Effect.Effect<PollResult, SmithersError>;
  /** Poll cadence. @default Schedule.spaced("5 seconds") */
  schedule?: import("effect").Schedule.Schedule<unknown>;
  /** Durable cursor persistence (e.g. `makeDbCursorStore(adapter)`). */
  cursorStore?: import("./CursorStore.ts").CursorStore;
};
