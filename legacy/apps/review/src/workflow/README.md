# workflow/

The smithers workflow itself.

- `createReviewWorkflow.tsx` — wires the task graph (resolve-target → preview
  → collect-changes / prepare-review → parallel per-file reviews → review →
  optional verify-findings / final-review → parallel narrate + quiz →
  walkthrough) over a per-run sqlite db.
- `createReviewAgents.ts` — picks Claude (subscription or metered-proxy
  api-key mode) or Codex engines.
- Verification: `verifyFindings.ts` (`buildVerifyFindingsPrompt`) asks an
  agent to refute findings; `verifyVerdictsSchema.ts` defaults `index` to -1
  so a missing index is ignored; `applyFindingVerdicts.ts` applies
  keep/drop/demote (demote never raises severity).
- Input: `reviewInputSchema.ts` extends the open-code-review schema;
  `normalizeReviewInput.ts` strips nulls so zod defaults apply.
- `writeOpenAiSchemaFile.ts` — converts zod schemas to Codex-strict JSON
  Schema temp files (per-task `--output-schema`).

Gotcha: downstream consumers must read the `final` table when verification
ran, `review` otherwise — the workflow computes this as `finalReview` and the
CLI mirrors the same rule.
