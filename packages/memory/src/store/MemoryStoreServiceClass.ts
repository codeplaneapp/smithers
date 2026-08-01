import type { Context } from "effect";

import type { MemoryStore } from "./MemoryStore.ts";

/** See {@link ../MemoryServiceClass.ts} for why this is an interface, not a class. */
export interface MemoryStoreService extends Context.ServiceClass.Shape<"MemoryStoreService", MemoryStore> {}

export type MemoryStoreServiceClass = Context.ServiceClass<MemoryStoreService, "MemoryStoreService", MemoryStore>;
