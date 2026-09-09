# Chain approvals

A policy approval suspends an unsettled catalog call. The runtime writes an
approval card with `payload.chain`, `payload.runId`, `payload.flow` (the call
name), and `payload.capability` (the requested claim). Background cards also
carry `payload.background`. After reload, the controller reconstructs the ask
from the persisted flow and capability, then resumes the same lineage.

An outbound grant permits one call of that name in that lineage. Other
lineages and commands cannot consume it. A denial has the same one-shot
scope; the refused call becomes a denied observation, and another attempt
asks again. Session grants cover a claim across calls until reload or
revocation. Revocation clears session grants, unconsumed one-shot grants,
denials, and pending asks. `approve:*` remains reserved for the human.

A script returning `park("approval")` records a terminal `Park`, not a policy
ask. It emits a park frame but cannot create an actionable approval card.
Only the chain's `ApprovalWait` result enters the policy approval path.

Cancellation follows the fiber's settled exit. A stop after a successful
approval wait cannot discard its card. The agent seat keeps the originating
backend across the park's done frame so the same lineage resumes there;
ordinary completion releases that routing record. Refused initial starts
leave no routing record.

Regression coverage: `ChainRuntime.test.ts` exercises controller approval
after root and background reloads, terminal script parks, the late-stop
window, and seat routing. `Policy.test.ts` exercises real catalog handlers
across consumption, scope, reconstructed decisions, and revocation.
