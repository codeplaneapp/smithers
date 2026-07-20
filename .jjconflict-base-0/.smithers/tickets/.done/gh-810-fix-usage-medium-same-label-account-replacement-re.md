# 🐛 fix(usage): [medium] same-label account replacement replays the previous provider's cached usage

GitHub: https://github.com/smithersai/smithers/issues/810

_via 2026-07 full-codebase audit_

## Summary

Usage-cache entries are keyed only by account label. Replacing an account under the same label with a different provider/configuration still reuses the old report.

## Where

- `packages/usage/src/getUsageForAccounts.js:42-63`
- `packages/accounts/src/addAccount.js:45-64`

## Failure scenario / repro

Cache a Kimi report under label same, then request a Codex account with the same label. The returned report still identifies Kimi and carries its old error.

## Impact

Operators see the wrong provider's quota, plan, errors, and reset windows, which can drive incorrect routing decisions.

## Suggested fix

Include provider and a non-secret configuration identity in the key, or validate report identity before reuse. Invalidate the label on account replacement.

## Tests

- Cover same-label provider replacement and same-provider configuration replacement
- Preserve valid same-account cache hits

## Dedupe notes

#722 concerns cached failed Claude probes, not identity collisions.


> Closed by ticket-fleet: landed on main in 4d36a590cc43d569014f8fc2476a8c2189cfba8a.
