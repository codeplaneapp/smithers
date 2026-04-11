import { Context } from "effect";
import type { MemoryStore } from "./MemoryStore";

export class MemoryStoreService extends Context.Tag("MemoryStoreService")<
  MemoryStoreService,
  MemoryStore
>() {}
