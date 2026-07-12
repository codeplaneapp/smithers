# Support dynamically generated workflow files as lifecycle-bound child nodes

GitHub: https://github.com/smithersai/smithers/issues/1002

Parent: smithers/gh-767-detached-child-runs-smithers-up-detach-orp-07nrnmp.md

Context: Subflow accepts static workflow objects or functions, but an architect cannot safely run a workflow file authored at runtime inside the parent lifecycle. Acceptance criteria: load a runtime-produced workflow path from an approved root; create a durable parent-linked child node; propagate input/output, cancellation, timeout, and resume; enforce the parent maxConcurrency/subtreeConcurrency budget; add real integration coverage.


> Closed by ticket-fleet sync: Implemented in packages/engine/src/workflow-file.js:51-96 with approved-root realpath containment, symlink escape protection, extension checks, and workflow validation. packages/engine/src/child-workflow.js:231-309 loads runtime files, creates deterministic parent-linked child runs, propagates input/output, signal, timeout, rootDir, workflowPath, and resume behavior. Graph and scheduler support subtreeConcurrency in packages/graph/src/extract.js:432-489,755-775 and packages/scheduler/src/scheduleTasks.js:112-164,480-519. Real integration coverage is in packages/engine/tests/dynamic-workflow-file-subflow.e2e.test.jsx, covering input/output and lineage, root escape, cancellation, timeout, resume without repeating finished work, and maxConcurrency. workflow-file, graph subtree, and scheduler subtree tests also pass. Targeted verification passed: 41 tests, 0 failures.
