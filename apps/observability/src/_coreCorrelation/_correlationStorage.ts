import { AsyncLocalStorage } from "node:async_hooks";
import type { CorrelationContext } from "./CorrelationContext.ts";
export declare const correlationStorage: AsyncLocalStorage<CorrelationContext>;
