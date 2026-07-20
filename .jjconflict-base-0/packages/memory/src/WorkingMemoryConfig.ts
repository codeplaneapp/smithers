import type { z } from "zod";
import type { MemoryNamespace } from "./MemoryNamespace";

export type WorkingMemoryConfig<
  T extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>,
> = {
  schema?: T;
  namespace: MemoryNamespace;
  ttlMs?: number;
};
