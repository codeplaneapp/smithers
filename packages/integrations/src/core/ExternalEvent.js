// @smithers-type-exports-begin
/** @typedef {import("./ExternalEvent.ts").ExternalEvent} ExternalEvent */
// @smithers-type-exports-end

import { Schema } from "effect";

/**
 * Runtime schema for {@link ExternalEvent}. Webhook sources decode incoming
 * requests through this schema so malformed decoder output fails loudly at
 * the ingress boundary instead of surfacing as a broken signal later.
 */
export const ExternalEventSchema = Schema.Struct({
    source: Schema.String,
    eventName: Schema.String,
    correlationId: Schema.NullOr(Schema.String),
    payload: Schema.Unknown,
    dedupeKey: Schema.String,
    receivedAtMs: Schema.Number,
});

export const decodeExternalEvent = Schema.decodeUnknown(ExternalEventSchema);
