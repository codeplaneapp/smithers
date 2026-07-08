<!-- Illustrative seeded-bug scorecard snapshot; numbers are regenerable and not a CI baseline. Regenerate with: bun evals/review-seeded-bugs/run.ts -->

# Review Seeded-Bug Scorecard

This committed scorecard documents the report shape for the opt-in review seeded-bug eval. Live reports are written under `.report/` and are intentionally gitignored because they spend real agent budget and depend on the configured review engine.

## Metrics

- **Recall:** matched planted bugs divided by all planted bugs.
- **Precision:** matched findings divided by matched findings plus false positives. Findings on clean controls count as false positives.
- **Anchor accuracy:** mean signed line offset, mean absolute line offset, and the fraction of matched findings within the tight line tolerance.
- **Severity calibration:** exact severity-match rate plus mean absolute ordinal error using `info < minor < major < critical`.

## Illustrative Snapshot

| Metric | Value |
| --- | ---: |
| Fixtures | 9 |
| Planted bugs | 7 |
| Clean controls | 2 |
| Recall | 71.4% |
| Precision | 62.5% |
| Mean absolute anchor offset | 1.2 lines |
| Tight-anchor rate | 80.0% |
| Severity exact-match rate | 60.0% |
| Mean severity ordinal error | 0.6 |

## Fixture Layout

| Fixture | Label | Expected review behavior |
| --- | --- | --- |
| `missing-await` | correctness / major | Flag the dropped `await` near `src/order.ts`. |
| `off-by-one-boundary` | correctness / major | Flag the excluded boundary page near `src/window.ts`. |
| `sql-injection` | security / critical | Flag string interpolation in the SQL query. |
| `resource-leak` | performance / major | Flag the removed file-handle close. |
| `deleted-null-check` | correctness / major | Flag the removed null fallback. |
| `tautological-test` | tests / minor | Flag the assertion that can never fail. |
| `cross-file-signature-mismatch` | correctness / major | Flag the caller still passing seconds after the helper changed to absolute milliseconds. |
| `clean-error-message` | clean control | Produce no findings. |
| `clean-refactor` | clean control | Produce no findings. |
