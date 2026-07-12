# 🔩 aws: [low] public .d.ts omits runtime options (awslogsStreamPrefix on ECS runner, workdir on S3 transport)

GitHub: https://github.com/smithersai/smithers/issues/723

_via ultracode (Opus multi-agent) review_

The published type declarations for two public `packages/aws` factories are narrower than the runtime they describe, so direct TypeScript callers can't pass supported options without an `as any`.

**1. `createAwsEcsSandboxRunner` — missing `awslogsStreamPrefix`**
- Type: `packages/aws/src/index.d.ts:195-208` (no `awslogsStreamPrefix`).
- Runtime reads it: `packages/aws/src/createAwsEcsSandboxRunner.js:199`.
- Provider passes it: `packages/aws/src/createAwsSandboxProvider.js:140`.

**2. `createAwsSandboxS3Transport` — missing `workdir`**
- Type: `packages/aws/src/index.d.ts:169-177` (no `workdir`).
- Runtime accepts/defaults it: `packages/aws/src/createAwsSandboxS3Transport.js:57,63`.
- Provider passes it: `packages/aws/src/createAwsSandboxProvider.js:104`.

Both are public exports (`packages/aws/src/index.js:5-6`).

**Failure scenario:** A TS consumer calling these public factories directly, e.g. `createAwsSandboxS3Transport({ s3, bucket, prefix, workdir: '/app' })` or `createAwsEcsSandboxRunner({ ..., awslogsStreamPrefix: 'myprefix' })`, is rejected by the excess-property check ("Object literal may only specify known properties"), forcing an `as any` even though the option is fully supported at runtime.

**Why it matters:** A published type surface narrower than its runtime blocks legitimate configuration through the exported API. Fix: add `awslogsStreamPrefix?: string` to the ECS runner options type (index.d.ts:195-208) and `workdir?: string` to the S3 transport config type (index.d.ts:169-177).
