# 🐛 fix(scorers): [medium] aggregate p50/stddev keyed by scorer_id only while rows grouped by (scorer_id, scorer_name)

GitHub: https://github.com/smithersai/smithers/issues/708

_via ultracode (Opus multi-agent) review_

**Summary:** `aggregateScores` computes p50/stddev over an id-wide score union that doesn't match each row's own count/mean/min/max when one `scorer_id` spans multiple `scorer_name`s.

**Where:**
- `packages/scorers/src/aggregate.js:43` — SQL `GROUP BY scorer_id, scorer_name` → one agg row per (id, name).
- `packages/scorers/src/aggregate.js:58-63` — `scoresByScorer` keyed on `row.scorer_id` only.
- `packages/scorers/src/aggregate.js:66` — `scoresByScorer.get(row.scorer_id)` returns the id-wide union.
- `packages/scorers/src/aggregate.js:67,69` — p50 and stddev computed over that union; `stddev` uses the per-(id,name) SQL `AVG` (`row.mean`, line 68) as its mean.

**Failure scenario:** `aggregateScores(adapter)` (no `runId` filter, workspace-wide) after a scorer keeps id `S` but is renamed 'Relevancy' → 'Answer Relevancy' across code versions. `_smithers_scorers` has no uniqueness tying `scorer_id` to `scorer_name` (see `packages/db/src/internal-schema/smithersScorers.js`), so the SQL returns two rows (e.g. S/'Relevancy' count=3, S/'Answer Relevancy' count=5) but `scoresByScorer.get('S')` returns all 8 scores. The count=3 row's p50/stddev are then computed from 8 values with the 3-value AVG as the mean — internally inconsistent with its own count/min/max.

**Why it matters:** This aggregate feeds the scores panel and regression/eval reports. A p50/stddev silently describing a different (larger) population than the row's count/mean/min/max misleads anyone comparing scorer variants or reading dispersion.

**Fix:** Key the in-memory scores map by the same composite (`scorer_id` + `scorer_name`) used in `GROUP BY`, and select `scorer_name` in the scores query.
