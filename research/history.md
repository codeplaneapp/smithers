# History and contributor cadence

Source snapshot: `84ac43ad1e0c6ec6f880d2a55876ee0a1ce93bf3` on `smthrs-dogfood` (tracks `main`), 2026-08-31.

- `git rev-list --count HEAD` reports 7280 commits.
- The repository is mid-migration to `1.0.0-rc.0` (see `PLAN.md` and
  `docs/migration/rc-contract.md`). The rc landing ran as named lanes merged
  in waves: `git log --oneline --grep='wave' -i | wc -l` reports 72 wave
  subjects, and `git log --oneline --merges --since=2026-08-29 | wc -l`
  reports 43 merge commits in the final three days.
- A single automation identity did the lane work: `git log --author='lane
  <lane@local>' --oneline | wc -l` reports 274 commits, all between
  2026-08-29 and 2026-08-31 (`git log --format='%ad %an' --date=short
  --author='lane@local' | sort | uniq -c`: 204 on 08-29, 53 on 08-30, 17 on
  08-31).
- Reconciling a lane against the moving integration tip is a repeated,
  identically-named commit: `git log --oneline --grep='build against the
  current cli-ops tip'` returns four commits, 853ca414c2, adc7a590a4,
  5785481fc7, 43a37686a3.
- Generated-file churn concentrates at the end of waves. `git log --oneline
  -- known-files.d.ts | wc -l` reports 23 commits, all since 2026-08-29
  (2 on 08-29, 6 on 08-30, 15 on 08-31 via `git log --format=%ad
  --date=short -- known-files.d.ts | sort | uniq -c`). Ten are standalone
  regen chores (5cc98912d0, cd14388ed7, 0fa6148b4b, d7c5a3e503,
  5ac7610b5c, 163fdf4bf5, 1f80d6dd66, 76c1b99413, 54cc0b242d, 1edeafb4e3).
  The drift gate arrived only after that pain: cb2ae764ad "ci(build): gate
  the known-file registry against its generator".
- Green-heart CI repair commits: `git log --oneline --grep='💚' | wc -l`
  reports 21, including 026a736c2f "restore main to green after the last
  four feature waves" and 69331f3b32 "repair the landed campaign's red
  gates".
- Lockfile pairing is history's largest unenforced invariant. Comparing
  `git log --format=%H -- pnpm-lock.yaml` against `git log --format=%H --
  bun.lock` with `comm`: 117 commits touch only `pnpm-lock.yaml`, 91 touch
  only `bun.lock`, 106 touch both. Repair commits include aa342e29a8,
  8d7168d98e, c80009d956, a07981e14f. A 0.x gate existed (340ca5461c
  "fix(ci): gate Bun lockfile drift") and did not survive the rc
  migration.
- Docs dominate subject lines: `git log --oneline --grep='docs(' --grep='docs:'
  | wc -l` reports 1076 commits. `docs/llms-full.txt` has 573 commits
  (`git log --oneline -- docs/llms-full.txt | wc -l`); in the rc era
  (`--since=2026-08-25`), 19 of 42 `docs/pages` commits shipped without a
  matching `docs/llms-full.txt` commit (comm -23 over the two `%H` lists).
- CLI churn: `git log --oneline --grep='fix(cli'` reports 257 commits,
  `feat(cli` 130, `test(cli` 131.
- `scripts/check-docs.mjs` has 196 commits (`git log --oneline --
  scripts/check-docs.mjs | wc -l`) and today holds 14 checks (the file's
  own header, line 5, and `grep -c 'fail(' scripts/check-docs.mjs` = 14).
- One dedicated sweep identity, `opus5-bug-sweep`, authored 44 commits
  (`git log --author='opus5-bug-sweep' --oneline | wc -l`), each closing a
  filed issue.

Commands: `git rev-list --count HEAD`, `git log --format='%ad %an'
--date=short`, `git log --oneline --grep=... `, `git log --oneline --
<path>`, `comm` over sorted `%H` lists.
