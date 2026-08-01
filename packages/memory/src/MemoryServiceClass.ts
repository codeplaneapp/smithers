import type { Context } from "effect";

import type { MemoryServiceApi } from "./MemoryServiceApi.ts";

/**
 * The instance shape of the {@link MemoryServiceClass} service key.
 *
 * Declared as an interface rather than a class so the generated
 * `index.d.ts` stays valid for `skipLibCheck: false` consumers: a
 * declaration file cannot `extends` the `Context.ServiceClass.Shape`
 * interface, which is what a class declaration rolls up to.
 */
export interface MemoryService extends Context.ServiceClass.Shape<"MemoryService", MemoryServiceApi> {}

export type MemoryServiceClass = Context.ServiceClass<MemoryService, "MemoryService", MemoryServiceApi>;
