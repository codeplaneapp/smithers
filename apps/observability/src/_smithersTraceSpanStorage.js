import { AsyncLocalStorage } from "node:async_hooks";
export const smithersTraceSpanStorage = new AsyncLocalStorage();
