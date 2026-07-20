# Gate devtools unmount callbacks to Smithers host fibers

GitHub: https://github.com/smithersai/smithers/issues/881

Update the React reconciler devtools unmount handler so onCommit("unmount", ...) is not emitted for composite fibers, ordinary host fibers such as div, or fibers from another renderer sharing the global hook. Add tests that invoke onCommitFiberUnmount for non-Smithers fibers and assert no public unmount callback is delivered, while a Smithers host fiber remains supported.
