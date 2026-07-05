# sessions/

Session minting for the GitHub Action. `handleSessions.ts` maps OIDC-token or
api-key auth to a registered repo, enforces the monthly spend cap BEFORE
claiming a quota slot, then runs `claimReviewSlot.ts` (a single conditional
INSERT, race-safe) and `mintSession.ts` (hashed `srs_` token, 2h TTL).

- `verifyOidc.ts` — full RS256 JWKS verification of GitHub Actions OIDC
  tokens, with tagged failure reasons.
- `fetchJwks.ts` + `jwksCache.ts` — 10-minute in-memory JWKS cache (tests
  clear the exported map).
- `lookupApiKey.ts` / `lookupRepo.ts` — hashed-key and repo-registration
  lookups.

Ordering invariant: spend-cap check, then quota claim, then mint — so a
blocked request never consumes a quota slot, and a crash after claiming
charges quota without leaking inference.
