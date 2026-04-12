import { Effect } from "effect";
export declare function withCurrentCorrelationContext<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>;
