export type CachePolicy<Ctx = unknown> = {
  by?: (ctx: Ctx) => unknown;
  version?: string;
  key?: string;
  ttlMs?: number;
  scope?: "run" | "workflow" | "global";
  [key: string]: unknown;
};
