import type { D1Database } from "./d1.ts";

type R2ObjectBody = { body: ReadableStream } | null;

export interface WalkthroughBucket {
  put(
    key: string,
    value: ArrayBuffer | string,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
  get(key: string): Promise<R2ObjectBody>;
}

/**
 * Bindings the worker reads at runtime. Cloudflare populates these from the
 * Alchemy resource graph (R2 bucket, D1 database, plain secrets); tests build
 * one by hand with a sqlite-backed D1 adapter and a stub bucket.
 */
export interface ReviewWorkerEnv {
  WALKTHROUGHS: WalkthroughBucket;
  DB: D1Database;
  REVIEW_PUBLISH_TOKEN: string;
  ADMIN_TOKEN: string;
  METRICS_TOKEN: string;
  ANTHROPIC_API_KEY: string;
  PUBLIC_BASE_URL?: string;
}
