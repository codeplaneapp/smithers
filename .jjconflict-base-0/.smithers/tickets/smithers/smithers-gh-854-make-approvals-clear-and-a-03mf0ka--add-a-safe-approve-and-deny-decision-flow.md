# Add a safe approve and deny decision flow

GitHub: https://github.com/smithersai/smithers/issues/953

Parent: smithers/gh-854-make-approvals-clear-and-actionable.md

Context: Approval actions can resume or stop durable runs, so the decision flow must prevent accidental denials and duplicate submissions. Acceptance criteria: Approve and Deny affordances are visually distinct and available for every pending row; denial requires an explicit confirmation that names the gate and run; optional decision notes are preserved; controls disable while submitting and cannot issue duplicate decisions; successful decisions remove or resolve the pending item; tests cover approval, denial, cancellation of confirmation, and duplicate-click behavior.
