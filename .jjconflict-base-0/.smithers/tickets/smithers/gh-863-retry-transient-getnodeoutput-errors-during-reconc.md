# Retry transient getNodeOutput errors during reconciliation

GitHub: https://github.com/smithersai/smithers/issues/863

Update delegationChainStore so unexpected transport or RPC failures are not permanently gated by the finish count captured on the failed attempt. Add bounded retry/backoff or equivalent finish-independent reconciliation, plus a regression test where the first fetch fails transiently and a later reconcile succeeds without another finish event.
