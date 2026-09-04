/**
 * KV surface the worker needs. Cloudflare's KVNamespace satisfies this;
 * tests provide an in-memory implementation with real TTL semantics.
 */
export interface BugKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

/**
 * Bindings the worker reads at runtime. Cloudflare populates these from the
 * Alchemy resource graph (KV namespace, secret); tests build one by hand.
 */
export interface BugWorkerEnv {
  BUGS: BugKv;
  /** Shared secret required in the x-bug-admin header for GET /api/bugs/:id. */
  BUG_ADMIN_TOKEN: string;
  /** Public origin used for the returned bug URL, e.g. https://bug.smithers.sh */
  PUBLIC_BASE_URL?: string;
}
