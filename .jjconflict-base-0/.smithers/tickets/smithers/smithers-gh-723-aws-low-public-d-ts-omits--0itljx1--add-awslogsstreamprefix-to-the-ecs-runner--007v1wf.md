# Add awslogsStreamPrefix to the ECS runner declaration

GitHub: https://github.com/smithersai/smithers/issues/998

Parent: smithers/gh-723-aws-low-public-d-ts-omits-runtime-options--12ivsux.md

Context: createAwsEcsSandboxRunner accepts and uses awslogsStreamPrefix at runtime, but packages/aws/src/index.d.ts excludes it from the public options type. Acceptance criteria: add awslogsStreamPrefix?: string to the declaration; add a TypeScript compile-time test or fixture proving direct calls with the option typecheck; preserve the existing runtime stream-prefix coverage.
