import { Context } from "effect";

/** @typedef {import("./MemoryServiceClass.ts").MemoryService} MemoryService */

/** @type {import("./MemoryServiceClass.ts").MemoryServiceClass} */
export const MemoryService = /** @type {never} */ (Context.Service("MemoryService"));
