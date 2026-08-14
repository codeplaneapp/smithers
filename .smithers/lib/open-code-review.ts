// Single source of truth: the OpenCodeReview workflow now lives in the published
// `@smthrs/review` package (so the `smithers review` CLI can ship
// it), and this pack module simply re-exports it. Keeping the implementation in
// one place means the built-in `open-code-review` workflow and the published CLI
// can never silently diverge. Edit the workflow at
// `apps/review/src/workflow/openCodeReview.ts`.
export * from "@smthrs/review/workflow/openCodeReview";
