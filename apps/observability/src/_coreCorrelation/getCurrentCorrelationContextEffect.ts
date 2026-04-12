import { Effect } from "effect";
import type { CorrelationContext } from "./CorrelationContext.ts";
export declare function getCurrentCorrelationContextEffect(): Effect.Effect<CorrelationContext | undefined>;
