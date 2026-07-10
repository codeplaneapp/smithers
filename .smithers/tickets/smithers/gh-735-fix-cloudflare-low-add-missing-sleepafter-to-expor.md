# 📝 fix(cloudflare): [low] add missing `sleepAfter` to exported CloudflareSandboxProviderOptions

GitHub: https://github.com/smithersai/smithers/issues/735

_via ultracode (Opus multi-agent) review_

The exported public type omits the `sleepAfter` option that the runtime reads and the JSDoc documents.

- `packages/cloudflare/src/index.d.ts:45` — `CloudflareSandboxProviderOptions` declares `keepAlive?: boolean` but no `sleepAfter`.
- `packages/cloudflare/src/index.js:202` — JSDoc typedef declares `sleepAfter?: string | number`.
- `packages/cloudflare/src/index.js:236` — runtime reads `options.sleepAfter` (commented "the main container cost lever").

**Failure scenario:** `createCloudflareSandboxProvider({ sleepAfter: "10m" })` fails `tsc` with `Object literal may only specify known properties, and 'sleepAfter' does not exist in type 'CloudflareSandboxProviderOptions'`. The idle-hibernation cost lever can only be set from TS via `as any` or by smuggling it through the untyped `sandboxOptions` field.

**Why it matters:** The published `.d.ts` and the JS JSDoc disagree on the public contract for the documented primary cost control. Fix: add `sleepAfter?: string | number;` to `CloudflareSandboxProviderOptions` and regenerate `dist/index.d.ts`.
