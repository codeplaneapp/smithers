# Support dynamically generated workflow files as lifecycle-bound child nodes

GitHub: https://github.com/smithersai/smithers/issues/1002

Parent: smithers/gh-767-detached-child-runs-smithers-up-detach-orp-07nrnmp.md

Context: Subflow accepts static workflow objects or functions, but an architect cannot safely run a workflow file authored at runtime inside the parent lifecycle. Acceptance criteria: load a runtime-produced workflow path from an approved root; create a durable parent-linked child node; propagate input/output, cancellation, timeout, and resume; enforce the parent maxConcurrency/subtreeConcurrency budget; add real integration coverage.
