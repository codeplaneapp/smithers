import { Effect } from "effect";
import type { CorrelationPatch } from "./CorrelationPatch.ts";
export declare function withCorrelationContext<A, E, R>(effect: Effect.Effect<A, E, R>, patch: CorrelationPatch): Effect.Effect<A, E, R>;
