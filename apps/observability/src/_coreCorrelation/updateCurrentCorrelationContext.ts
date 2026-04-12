import { Effect } from "effect";
import type { CorrelationContext } from "./CorrelationContext.ts";
import type { CorrelationPatch } from "./CorrelationPatch.ts";
export declare function updateCurrentCorrelationContext(patch: CorrelationPatch): Effect.Effect<CorrelationContext | undefined>;
