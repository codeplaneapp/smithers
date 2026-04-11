import { Context } from "effect";
import type { MemoryServiceApi } from "./MemoryServiceApi";

export class MemoryService extends Context.Tag("MemoryService")<
  MemoryService,
  MemoryServiceApi
>() {}
