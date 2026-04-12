import { AsyncLocalStorage } from "node:async_hooks";
import type * as Tracer from "effect/Tracer";
export declare const smithersTraceSpanStorage: AsyncLocalStorage<Tracer.AnySpan>;
