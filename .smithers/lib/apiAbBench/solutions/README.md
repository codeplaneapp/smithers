# api-ab-benchmark reference solutions

Hand-written correct solutions for all three benchmark tasks in both arms. They
exist to prove the harness can score a correct candidate `correct` in either
arm before any agent runs:

```sh
cp solutions/effect-pipeline.ts ../../workflows/.api-ab-benchmark/effect/pipeline/1/candidate.ts
cp solutions/jsx-pipeline.tsx  ../../workflows/.api-ab-benchmark/jsx/pipeline/1/candidate.tsx
# ...then call scoreCandidate(arm, spec, 1) from the workflow module.
```

This directory is excluded from `pnpm -C .smithers typecheck`. The three
`effect-*.ts` files cannot typecheck today: the Effect API's shipped type
declarations carry no generic inference, so a step's `input` and its dependency
values are typed `unknown` and `G.step` returns an untyped graph value. That is
an API-level typing gap, not a defect in these solutions -- all six execute and
produce exactly the expected result. It is also why the benchmark records
`typechecks` but excludes it from `firstTryClean`.
