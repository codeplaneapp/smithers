import { Context } from "effect";

/** @typedef {import("./MemoryStoreServiceClass.ts").MemoryStoreService} MemoryStoreService */

/** @type {import("./MemoryStoreServiceClass.ts").MemoryStoreServiceClass} */
export const MemoryStoreService = /** @type {never} */ (Context.Service("MemoryStoreService"));
