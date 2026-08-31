# Issue themes

Source snapshot: `84ac43ad1e0c6ec6f880d2a55876ee0a1ce93bf3`, 2026-08-31.
Repository: github.com/smithersai/smithers, 1629 issues/PRs numbered to date
(`gh issue list --state all --limit 1 --json number`). Counts come from
`gh api "search/issues?q=repo:smithersai/smithers is:issue <query>"
--jq .total_count` with the query shown; GitHub full-text search is
approximate, so treat counts as ranking signal, not exact tallies.

| Theme | Query | Issues |
| --- | --- | --- |
| Gateway and UI | `gateway OR ui` | 468 |
| Resume, retry, durability | `resume OR retry` | 295 |
| Migration and schema | `migration OR schema` | 222 |
| Adapters and providers | `adapter` | 144 |
| Approvals and gates | `approval OR gate` | 171 |
| Time travel | `time-travel OR rewind` | 76 |
| Quota and rate limits | `quota OR "rate limit"` | 56 |
| Time-travel/rewind | see above | 54 (rewind-only overlap) |
| Packaging and publish | `packaging OR publish` | 53 |
| Subflows | `subflow` | 49 |
| CI red and flake | `flaky OR flake OR "red main" OR "CI red"` | 34 |
| Workflow authoring | `workflow authoring` | 14 |

## Notable clusters

- Subflow: most of the 49 subflow issues belong to one audit, #1386-#1412,
  under umbrella #1412 "feature x child-workflow (subflow) audit — 26
  confirmed defects" (closed; `gh issue view 1412`).
- CI red: #1549 (shard 3 deterministically red, SQLITE_BUSY cascade) and
  #1577 (recurring SQLite wedge on shard 3) both closed by PR #1617 "stop
  leaking createSmithers sqlite handles" plus PR #1621 "assert webhook
  metric deltas" (`gh issue view` / `gh pr view` per number).
- Committed-tree drift: #1443 "sol-issue-train gate must run the full root
  check set — every wave re-reddens main CI with gate-invisible drift"
  (closed), fixed structurally by PR #1538 "gate issue train on committed
  root checks"; #1442 records tests that landed expecting an unmerged
  file. 21 green-heart repair commits exist in history (026a736c2f,
  69331f3b32, a425fe3d88, ...; `git log --oneline --grep='💚' | wc -l`).
- Adapter gap sets recur per provider: #1590 (Grok support) closed by PR
  #1608; #1622-#1626 (CodexAgent argv, wire-schema, and stream gaps)
  closed by PR #1627; #1629 (PiAgent stale streamed text) is open.
- The `opus5-bug-sweep` identity authored 44 issue-closing commits
  (`git log --author='opus5-bug-sweep' --oneline | wc -l`), showing issue
  triage already runs as an agent campaign.
