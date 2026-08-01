import { Context } from "effect";
/** @typedef {import("./MemoryServiceApi.ts").MemoryServiceApi} MemoryServiceApi */

/** @typedef {Context.ServiceClass.Shape<"MemoryService", MemoryServiceApi>} MemoryService */
const MemoryServiceTag = /** @type {Context.ServiceClass<MemoryService, "MemoryService", MemoryServiceApi>} */ (
  Context.Service()("MemoryService")
);
export const MemoryService = /** @type {Context.ServiceClass<MemoryService, "MemoryService", MemoryServiceApi>} */ (
  class MemoryService extends MemoryServiceTag {
    constructor(...args) {
      super(...args);
    }
  }
);
