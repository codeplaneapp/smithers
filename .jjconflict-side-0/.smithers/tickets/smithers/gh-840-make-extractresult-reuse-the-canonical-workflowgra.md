# Make ExtractResult reuse the canonical WorkflowGraph type

GitHub: https://github.com/smithersai/smithers/issues/840

Replace the independent mutable declaration in packages/graph/src/ExtractResult.ts with an alias or re-export of the canonical WorkflowGraph from types.ts, regenerate its declaration, and add coverage preventing shape drift.
