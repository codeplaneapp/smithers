/**
 * Where a usage report's numbers came from.
 *
 * - `oauth`   — an authenticated subscription usage endpoint (Claude, Codex).
 * - `headers` — live rate-limit response headers from an API-key request.
 * - `local`   — estimated locally from token logs (Google providers).
 * - `none`    — the provider exposes no usage surface, or the probe failed.
 */
export type UsageSource = "oauth" | "headers" | "local" | "none";
