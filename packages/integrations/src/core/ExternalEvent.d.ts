import { ExternalEvent as ExternalEvent$1 } from './ExternalEventTypes.js';
import * as effect_Effect from 'effect/Effect';
import * as effect_SchemaIssue from 'effect/SchemaIssue';
import * as effect_SchemaAST from 'effect/SchemaAST';
import { Schema } from 'effect';

/**
 * Runtime schema for {@link ExternalEvent}. Webhook sources decode incoming
 * requests through this schema so malformed decoder output fails loudly at
 * the ingress boundary instead of surfacing as a broken signal later.
 */
declare const ExternalEventSchema: Schema.Struct<{
    readonly source: Schema.String;
    readonly eventName: Schema.String;
    readonly correlationId: Schema.NullOr<Schema.String>;
    readonly payload: Schema.Unknown;
    readonly dedupeKey: Schema.String;
    readonly receivedAtMs: Schema.Number;
}>;
declare const decodeExternalEvent: (input: {
    readonly source: string;
    readonly eventName: string;
    readonly correlationId: string | null;
    readonly payload: unknown;
    readonly dedupeKey: string;
    readonly receivedAtMs: number;
}, options?: effect_SchemaAST.ParseOptions) => effect_Effect.Effect<{
    readonly source: string;
    readonly eventName: string;
    readonly correlationId: string | null;
    readonly payload: unknown;
    readonly dedupeKey: string;
    readonly receivedAtMs: number;
}, effect_SchemaIssue.Issue, never>;
type ExternalEvent = ExternalEvent$1;

export { type ExternalEvent, ExternalEventSchema, decodeExternalEvent };
