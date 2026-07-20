# 🐛 review: overview-chart segment bump overflows the track, clipping the deletions bar

GitHub: https://github.com/smithersai/smithers/issues/599

**What happens**
`apps/review/src/walkthrough/renderOverviewChart.ts:23-36` — `barSegments` computes `total = sqrt(churn/maxChurn)*100`, splits it into `addPct`/`delPct`, then bumps either segment up to `MIN_SEGMENT_PCT` (1.5) without shrinking the other.

**Why it's wrong / failure scenario**
For the max-churn row `total` is 100. With e.g. insertions=9990, deletions=10, `addPct` = 99.9 and `delPct` = 0.1 → bumped to 1.5, so the two divs request ~101.4% of the track (plus the flex gap). The track clips the trailing deletions segment, defeating the very visibility guarantee the bump exists for.

**Expected behavior**
Bumping a segment to the minimum should subtract the excess from the other segment (or cap the sum at `total`), so both segments always render fully inside the track.

Cosmetic only — no data is wrong, just the rendered bar.

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).


> Closed by ticket-fleet: landed on main in 5374a51cc63afb7c0b3efca2f1dd82a5b0864fda.
