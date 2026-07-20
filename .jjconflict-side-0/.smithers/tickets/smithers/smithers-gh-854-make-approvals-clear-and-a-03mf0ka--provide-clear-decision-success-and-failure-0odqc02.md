# Provide clear decision success and failure feedback

GitHub: https://github.com/smithersai/smithers/issues/954

Parent: smithers/gh-854-make-approvals-clear-and-actionable.md

Context: Operators must know whether a decision reached the gateway and what to do after a failure. Acceptance criteria: Success feedback identifies the decision and target gate/run and reflects the updated pending state; RPC or refresh failures are shown inline or in an accessible status region with the actual actionable error; failed submissions retain the pending request and re-enable retry; tests cover success, gateway rejection, refresh failure, and retry.
