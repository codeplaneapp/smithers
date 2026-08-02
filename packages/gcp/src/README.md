# @smthrs/gcp — src

A first-class Smithers **sandbox provider** for Google Cloud. It executes a
Smithers bundle on **Cloud Run Jobs** and ships the request/result bundles
through a **Cloud Storage** bucket, because Cloud Run Jobs give no shared
filesystem back to the caller.

Built on `@smthrs/sandbox`'s provider-kit
(`createCommandSandboxProvider`): the kit owns the request/result protocol,
egress, secret scrubbing, and cleanup. This package only implements the
`SandboxSession` seam — GCS transport + Cloud Run runner.

## Exports

- `createGcpSandboxProvider(options)` — the provider factory.
- `registerGcpSandboxProvider(options)` — construct + register globally; returns
  the unregister function.
- `createMockGcpSandboxEnvironment(handler, config?)` — in-memory SDK double
  (Cloud Storage + Cloud Run) for tests; ZERO real GCP creds/bucket needed.
- `createGcpSandboxGcsTransport`, `createGcpCloudRunJobsSandboxRunner` — the two
  building blocks, exported for advanced composition/testing.
- `GCP_SANDBOX_PROVIDER_ID` — `"gcp-sandbox"`.

## Required options

`createGcpSandboxProvider({ projectId, location, bucket, jobName })` — all four
are required (missing ones throw `INVALID_INPUT`). `projectId` falls back to
`GOOGLE_CLOUD_PROJECT`.

| option      | meaning                                                        |
| ----------- | ------------------------------------------------------------- |
| `projectId` | GCP project id                                                |
| `location`  | Cloud Run region, e.g. `us-central1`                          |
| `bucket`    | a **pre-existing** Cloud Storage bucket (transport)           |
| `jobName`   | Cloud Run Job to run (or created per-run when `createJob`)    |

Other knobs: `prefix` (default `smithers/sandbox`), `command`, `workdir`,
`env`, `cleanup` (`"destroy"` | `"keep"`), `timeoutSec`, `createJob`,
`sandboxId(request)`, and `client`/`clients`/`clientOptions` for SDK injection.

## Auth & env

Authentication is **Application Default Credentials**:
`GOOGLE_APPLICATION_CREDENTIALS` (a service-account key file) or workload
identity, plus `GOOGLE_CLOUD_PROJECT`. Local credentials are **never** forwarded
into the container; the container env is `options.env` plus the Smithers/egress
and GCS-transport variables below.

## Usage

```tsx
import { Sandbox } from "smthrs/components";
import { createGcpSandboxProvider } from "@smthrs/gcp";

const provider = createGcpSandboxProvider({
  projectId: "my-project",
  location: "us-central1",
  bucket: "my-smithers-sandbox",
  jobName: "smithers-sandbox-runner",
});

<Sandbox provider={provider}>{/* child workflow */}</Sandbox>;
```

## Request/result JSON contract

The kit writes `.smithers/sandbox-request.json` and expects
`.smithers/sandbox-result.json` back (paths handed to the container via
`SMITHERS_SANDBOX_REQUEST_PATH` / `SMITHERS_SANDBOX_RESULT_PATH`). Because
there is no shared filesystem, the container round-trips those files through
GCS. The runner injects four extra vars so the entry can find them:

- `SMITHERS_SANDBOX_GCS_BUCKET` — the transport bucket
- `SMITHERS_SANDBOX_GCS_PREFIX` — object-name prefix
- `SMITHERS_SANDBOX_REQUEST_GCS_OBJECT` — object holding the request JSON
- `SMITHERS_SANDBOX_RESULT_GCS_OBJECT` — object the entry must write result JSON to

Every workdir-relative path maps to
`<prefix>/<runId>/<sandboxId>/<basename(path)>`.

Failure semantics: a Cloud Run execution with a succeeded task is exit 0; a
failed task is exit 1 (Cloud Run reports task counts/conditions, not a numeric
exit code). An **infra failure** (execution failed, no result written) throws;
a run that completes but writes `status:"failed"` result JSON is a normal failed
bundle the kit materializes.

## Cleanup & cost

`destroy` (default) deletes the transient GCS objects and, when `createJob` made
a per-run job, deletes that job. `keep` leaves everything. The bucket itself is
**never** created or deleted — bring a pre-existing bucket and set a short
lifecycle TTL on the `smithers/sandbox/` prefix to reap anything a crash leaves
behind. Compute Engine execution is documented future work (not implemented).

## Gotchas

- `@google-cloud/run` and `@google-cloud/storage` are optionalDependencies,
  imported lazily inside `createSession` so the package loads without them.
- `createMockGcpSandboxEnvironment` implements only the SDK subset used here.
- `src/index.d.ts` is generated-but-committed — never hand-edit it.
