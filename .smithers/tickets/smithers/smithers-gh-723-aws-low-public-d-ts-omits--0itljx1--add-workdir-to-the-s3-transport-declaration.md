# Add workdir to the S3 transport declaration

GitHub: https://github.com/smithersai/smithers/issues/999

Parent: smithers/gh-723-aws-low-public-d-ts-omits-runtime-options--12ivsux.md

Context: createAwsSandboxS3Transport accepts workdir and defaults it at runtime, but packages/aws/src/index.d.ts excludes it from the public config type. Acceptance criteria: add workdir?: string to the declaration; add a TypeScript compile-time test or fixture proving direct calls with the option typecheck; preserve the existing workdir mapping tests.
