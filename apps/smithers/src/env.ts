/**
 * Bindings available to the Cloudflare Worker at runtime. `CEREBRAS_API_KEY` is
 * a Cloudflare secret (set by Alchemy from the deploy environment); `ASSETS` is
 * the static-assets fetcher the platform injects for the built PWA.
 */
export interface CloudflareEnv {
  CEREBRAS_API_KEY: string;
  ASSETS?: { fetch: (request: Request) => Promise<Response> };
}
