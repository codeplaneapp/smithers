import type { z } from "zod";
import type { MemoryNamespace } from "./MemoryNamespace";

export type WorkingMemoryConfig<T extends z.ZodObject<any> = z.ZodObject<any>> = {
  schema?: T;
  namespace: MemoryNamespace;
  ttlMs?: number;
};
