# Review Seeded-Bug Eval

This eval corpus exercises smithers review on small fixture repositories with known outcomes. Each fixture has a `base/` tree, a `head/` tree, and a `label.json` manifest. Bug fixtures plant one labeled defect; clean controls should produce no findings.

Covered bug classes:

- `missing-await`
- `off-by-one-boundary`
- `sql-injection`
- `resource-leak`
- `deleted-null-check`
- `tautological-test`
- `cross-file-signature-mismatch`

The deterministic scorer lives in `score.ts` and does not perform I/O or call agents. It matches review findings to labels by relative path and line anchor tolerance, then reports recall, precision, anchor accuracy, and severity calibration.

## CI-Safe Checks

```bash
bun test evals/review-seeded-bugs/score.test.ts
tsc -p evals/tsconfig.json --noEmit
```

The Bun test validates corpus integrity and synthetic scoring math only. It is safe for CI and does not spend model budget.

## Opt-In Live Run

```bash
bun evals/review-seeded-bugs/run.ts
```

The live runner materializes each fixture as a temporary git repository, commits `base/`, applies `head/` as working-tree changes, runs the real review workflow, reads the review output rows, scores the findings, and writes a timestamped report under `.report/`.

Running this command uses the configured review agents and can spend real agent budget. `.report/` is gitignored; do not commit live run outputs.
