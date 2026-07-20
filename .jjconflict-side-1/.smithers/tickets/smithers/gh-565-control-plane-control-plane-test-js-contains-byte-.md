# 🧹 control-plane: control-plane.test.js contains byte-identical duplicated test blocks (3-5 copies each)

GitHub: https://github.com/smithersai/smithers/issues/565

**What happens**
packages/control-plane/tests/control-plane.test.js contains verbatim-duplicated tests, apparently from repeated append-merges:
- "audit export defaults malformed stored metadata to empty objects" — 3 copies (lines 242, 287, 332)
- "usage limit periods are validated and define default quota windows" — 5 copies (lines 448, 504, 560, 616, 672)
- "usage and audit events reject missing projects with typed errors" — 5 copies (lines 474, 530, 586, 642, 697)

Sampled blocks verified byte-identical with `diff <(sed -n 242,286p …) <(sed -n 287,331p …)` etc.

**Why it matters**
~350 redundant lines re-executed on every `bun test`, plus duplicate test names that make failures ambiguous.

**Expected**
One copy of each test.

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).
