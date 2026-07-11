# Complete node inspector output loading, error, and missing-output states

GitHub: https://github.com/smithersai/smithers/issues/963

Parent: smithers/gh-855-add-complete-monitor-loading-empty-and-error-state.md

Context: NodeInspector handles successful output, failed-node output, running nodes, and missing output, but it ignores useGatewayNodeOutput().error and therefore conflates fetch failures with genuinely absent output. Acceptance criteria: 1. Output loading is distinct from no output. 2. A failed output query shows an actionable error and retry control. 3. A completed node with no recorded output has a distinct missing-output explanation. 4. A failed node preserves its failure details while explaining output absence. 5. Live transcript fetch failures are distinguished from a node that has produced no events. 6. Add component tests for every branch.
