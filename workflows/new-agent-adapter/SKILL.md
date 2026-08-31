# New agent adapter

Add one provider adapter and its conformance coverage from the supplied
provider, binary, and model IDs. Issue #1590 reached Grok support in PR #1608,
then issues #1622 through #1626 required the follow-up gap set closed by PR
#1627; #1629 records another streamed-session gap. Treat that pattern as the
minimum checklist, not cleanup for a later change.

## Inputs

- `provider` is the human name and stable lowercase provider ID. Do not infer
  aliases that were not supplied.
- `binary` is the executable contract. Keep it as an argv element; never build
  a shell command string from it.
- `models` is the exact comma- or newline-separated model set. Preserve
  provider model IDs verbatim and reject an empty set.

## Current seams

Read the implementation before choosing a home:

- `packages/agent/src/SeatResolver.ts` is the host seam from a declared seat
  to a live model. `packages/cli/src/NodeControl.ts` installs the credentialed
  Node resolver.
- `packages/model/src/Protocol.ts` owns request lowering, frame decoding, the
  stream state machine, and provider-error classification. Normalize output to
  `packages/model/src/ModelEvent.ts` and errors to
  `packages/model/src/ModelError.ts`; retry transport behavior belongs at
  `packages/model/src/RequestExecutor.ts`.
- `packages/agent/src/AgentSession.ts` owns durable session and resume wiring.
  `packages/agent/src/Budget.ts` consumes normalized usage, and
  `packages/agent/src/QuotaPolicy.ts` turns classified quota refusals into
  bounded durable waits.
- `packages/model/src/Auth.ts`, `packages/cli/src/NodeControl.ts`, and
  `packages/cli/src/Doctor.ts` are the existing auth and host-probe surfaces.

Keep provider wire details in `packages/model/src`, shared durable policy in
`packages/agent/src`, and credentialed host wiring in `packages/cli/src`.
Extend those seams; do not recreate a parallel agent runtime.

## Procedure

1. Confirm the provider ID, executable, model list, protocol family, auth
   method, and whether the adapter belongs in this repository under the rc
   contract. Start from the nearest current protocol rather than copying an
   unrelated provider wholesale.
2. Implement the smallest provider codec and registration surface: validated
   request body, framed stream decoder/state machine, terminal handling, error
   classification, seat/model resolution, and public exports where the current
   package pattern requires them. Capture scrubbed provider transcripts as
   fixtures; never commit credentials, account IDs, or raw private prompts.
3. Complete the recurring conformance checklist in the same change:

   - **Argv surface.** Put argv construction behind a pure function. Test zero,
     one, and multiple `addDir` values. Multiple directories must remain
     distinct repeated arguments in input order, including paths with spaces;
     no join-and-shell shortcut is allowed. Pin the provider, model, resume,
     and non-interactive flags the binary actually supports.
   - **Usage normalizer.** Translate every provider counter into
     `ModelEvent.Usage`, including input, output, reasoning, cached-input,
     cache-write, and total tokens when supplied. Preserve missing as missing,
     reject malformed numbers, and emit one settled usage contribution so
     `packages/agent/src/Budget.ts` cannot double count it.
   - **Session resume.** Preserve the provider-native session or continuation
     identifier across a durable restart and route it through the existing
     `packages/agent/src/AgentSession.ts` resume path. Test that resume
     continues the same session and does not replay already-settled text or
     usage.
   - **Rate-limit classification.** Map HTTP 429 and provider-specific quota or
     rate-limit codes to `ModelError`'s `rate_limited` or `quota_exceeded`
     vocabulary. Preserve retry-after/reset metadata and test the handoff to
     `packages/agent/src/QuotaPolicy.ts`, including the no-metadata fallback.
   - **Accounts/auth probe.** Add a read-only availability probe through
     `packages/model/src/Auth.ts` and the Node host/doctor surfaces. Cover
     present, missing, expired, and malformed auth without printing or
     returning credential material. A probe reports capability; it never logs
     in, mutates an account file, or silently falls back to another provider.

4. Add deterministic unit and conformance tests for fragmented stream frames,
   tool calls, stop reasons, malformed events, process exit/abort, every
   applicable checklist item, and each supplied model ID. Fixtures must run
   offline after capture.
5. Run the complete `agent`, `model`, and `cli` package suites. If a manifest
   changes, refresh both `pnpm-lock.yaml` and `bun.lock` and keep the dependency
   delta adapter-specific.

## Decline conditions

Decline without edits when the provider ID, binary, or model set is missing or
ambiguous; no scrubbed protocol evidence is available; the binary's real argv,
resume, usage, or auth behavior cannot be established; the adapter belongs in
an external plugin repository under the current rc contract; a required probe
would expose or mutate credentials; or supporting the provider requires a new
cross-package contract not decided here. Do not fabricate wire events, model
IDs, CLI flags, account formats, or rate-limit metadata to make tests pass.
