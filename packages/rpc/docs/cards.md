# Cards persistence contract

`CardSchema` decodes persisted rows and embedded card snapshots. Valid historical
`agent-form` rows become `flow-form` rows with the same id and draft. Create forms
continue `agent.create`; edit forms continue `agent.edit` with the original id in
`given`. Saved and cancelled forms remain settled. Interrupted saves are editable.
Malformed historical rows still fail validation.

`CardPatchSchema` requires `kind`, including for metadata-only updates. Its payload
is a shallow partial of that kind's payload schema; nested objects and arrays retain
their full validation, including file diagnostic caps. The `repo-onboarding` payload
is an atomic replacement because its required fields depend on `stage`. Consumers
must require the patch kind to match the existing card, merge payload fields, then
validate the resulting card with `CardSchema` before storing the parsed result.
The UI store fills in the existing kind for local transitions; model frames must
provide it. Environment transitions are redacted before journaling or tracing.

Environment variable `value` fields are display-only. Decoding cards and patches
keeps three leading characters followed by `…`; values of three characters or fewer
become `…`. Repeated decoding is stable. Use parsed values for persistence and
re-read upstream when a raw value is needed. This does not scrub old bytes already
on disk; it redacts them when decoded and on subsequent writes.
