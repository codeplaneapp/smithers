import { AsyncLocalStorage } from "node:async_hooks";
export const correlationStorage = new AsyncLocalStorage();
