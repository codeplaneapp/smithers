# E2E Flake Log

Per ticket 0022 meta-testing: a fault-injection case is only promoted from
**nightly-only** to the **per-PR subset** after observing **0 flakes per 100
consecutive CI runs**. Every flake — even one that "looks unrelated" — is
recorded here, with the resolution. If the resolution is "retry passed",
the 100-run counter for that case resets.

| Date | Test ID | Run | Failure mode | Resolution |
| ---- | ------- | --- | ------------ | ---------- |
