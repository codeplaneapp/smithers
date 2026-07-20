import { ExternalEvent as ExternalEvent$1 } from './ExternalEventTypes.js';
import * as effect_Effect from 'effect/Effect';
import * as effect_ParseResult from 'effect/ParseResult';
import * as effect_SchemaAST from 'effect/SchemaAST';
import { Schema } from 'effect';

/**
 * Runtime schema for {@link ExternalEvent}. Webhook sources decode incoming
 * requests through this schema so malformed decoder output fails loudly at
 * the ingress boundary instead of surfacing as a broken signal later.
 */
declare const ExternalEventSchema: Schema.Struct<{
    source: typeof Schema.String;
    eventName: typeof Schema.String;
    correlationId: Schema.NullOr<typeof Schema.String>;
    payload: typeof Schema.Unknown;
    dedupeKey: typeof Schema.String;
    receivedAtMs: typeof Schema.Number;
}>;
declare const decodeExternalEvent: (u: unknown, overrideOptions?: effect_SchemaAST.ParseOptions) => effect_Effect.Effect<{
    readonly source: string;
    readonly eventName: string;
    readonly correlationId: string | null;
    readonly payload: unknown;
    readonly dedupeKey: string;
    readonly receivedAtMs: number;
}, effect_ParseResult.ParseError, never>;
type ExternalEvent = ExternalEvent$1;

export { type ExternalEvent, ExternalEventSchema, decodeExternalEvent };
