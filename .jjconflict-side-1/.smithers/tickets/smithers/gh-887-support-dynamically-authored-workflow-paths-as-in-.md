# Support dynamically authored workflow paths as in-run child nodes

GitHub: https://github.com/smithersai/smithers/issues/887

Extend Subflow or a related child-workflow API to accept a workflow path or runtime-produced workflow definition, load and validate it within the parent execution context, and preserve lifecycle linkage, cancellation, resume, and output propagation. Add end-to-end tests for an architect-authored child workflow.
