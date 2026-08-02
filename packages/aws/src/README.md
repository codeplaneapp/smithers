# @smthrs/aws — src

AWS sandbox provider for Smithers. It runs a Smithers sandbox request on AWS
Fargate (ECS `RunTask`) or AWS CodeBuild and transports the request/result
bundle through S3, because AWS gives the orchestrator no shared filesystem with
the remote task.

## Exports

- `createAwsSandboxProvider(options)` — the provider factory. `mode: "fargate"`
  (default) or `"codebuild"`.
- `registerAwsSandboxProvider(options)` — construct + register with the sandbox
  runtime; returns the unregister function.
- `createMockAwsSandboxEnvironment(handler, mockOptions?)` — in-memory S3 + ECS +
  CodeBuild + CloudWatch Logs doubles for tests (zero AWS creds).
- `createAwsSandboxS3Transport`, `createAwsEcsSandboxRunner`,
  `createAwsCodeBuildSandboxRunner` — the composable pieces.
- `AWS_SANDBOX_PROVIDER_ID` — `"aws-sandbox"`.

## Usage

```js
import { createAwsSandboxProvider } from "@smthrs/aws";

// Fargate (default)
const provider = createAwsSandboxProvider({
  region: "us-east-1",
  bucket: "my-smithers-sandbox-bucket", // must already exist
  cluster: "smithers",
  taskDefinition: "smithers-sandbox:7",
  subnets: ["subnet-abc123"],
  securityGroups: ["sg-def456"],
  assignPublicIp: "ENABLED",
  containerName: "runner",
});

// CodeBuild
const codebuild = createAwsSandboxProvider({
  mode: "codebuild",
  region: "us-east-1",
  bucket: "my-smithers-sandbox-bucket",
  projectName: "smithers-sandbox",
});
```

Then pass the provider to `<Sandbox provider={provider}>`.

## Prerequisites

- Authentication uses the **standard AWS SDK v3 credential chain** (env vars,
  shared config, SSO, instance/task role). No explicit credentials are passed;
  none are ever forwarded into the remote task env.
- The S3 `bucket` must **already exist** — the provider only manages the key
  prefix `smithers/sandbox/<runId>/<sandboxId>/` under it.
- The `@aws-sdk/*` clients are **optionalDependencies**, imported lazily. Install
  the ones your mode needs: `@aws-sdk/client-s3` (always),
  `@aws-sdk/client-ecs` (fargate), `@aws-sdk/client-codebuild` (codebuild),
  `@aws-sdk/client-cloudwatch-logs` (only with `captureLogs`).

## Request / result contract

The container entry command reads the request JSON and writes the result JSON
through S3. In addition to the kit's `SMITHERS_SANDBOX_REQUEST_PATH` /
`SMITHERS_SANDBOX_RESULT_PATH`, the provider injects:

- `SMITHERS_SANDBOX_S3_BUCKET` — the transport bucket.
- `SMITHERS_SANDBOX_S3_PREFIX` — `smithers/sandbox/<runId>/<sandboxId>`.
- `SMITHERS_SANDBOX_REQUEST_S3_KEY` — S3 key of the request JSON.
- `SMITHERS_SANDBOX_RESULT_S3_KEY` — S3 key the entry must write the result to.

Every workdir path maps to `s3://<bucket>/<prefix>/<basename(path)>`.

An **infra failure** (task/build fails, no result written) throws; a result file
with `status: "failed"` is a normal failed bundle. Fargate reports a real
numeric container exit code; CodeBuild reports a status (`SUCCEEDED` → 0, else
1).

## Cleanup & cost

`cleanup: "destroy"` (default) stops the task/build if still running and deletes
the transient S3 objects; `cleanup: "keep"` leaves them. You pay for Fargate
task time / CodeBuild build minutes plus S3 storage of the (small, transient)
bundle objects.

`src/index.d.ts` is generated-but-committed — never hand-edit it.
