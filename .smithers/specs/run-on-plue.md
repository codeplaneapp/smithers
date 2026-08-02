# Run any Smithers script on Plue infrastructure

> Working specification for the `run-on-plue` feature. Plue is the infrastructure
> control plane and Microsandbox is its only sandbox provider.

## Goal

Run an arbitrary Smithers workflow source file inside a real Plue workspace while
keeping Plue responsible for authentication, quotas, repository binding,
placement, workspace lifecycle, and public access gateways.

The integration uses the shared `SandboxProvider` seam. Smithers sends a
provider-neutral request to the Plue provider; Plue creates a workspace through
its authenticated CLI/API and schedules the guest through its Microsandbox
controller. Smithers never contacts a worker directly.

## Contract

- Input contains workflow source, filename, agent configuration, and workflow input.
- The provider creates a repo-bound Plue workspace and polls until the workspace
  and SSH gateway are ready.
- It stages a small project containing the workflow source, `agents.ts`,
  `package.json`, and `input.json`.
- It executes `bunx smthrs up <file> --input <json>` in the guest
  and maps the run result into `SandboxProviderResult`.
- Cleanup deletes the workspace unless `keepWorkspace` was explicitly selected.
- A provider error returns a typed failed result and never falls back to another
  backend.

## Authentication and secrets

Authentication is operation-scoped and never baked into guest disks, snapshots,
images, command arguments, logs, errors, or durable provider state. The provider
may stage short-lived CLI authentication over an encrypted channel for the
duration of the operation. Richer method/path policy, approval, signing, audit,
or response filtering uses a short-lived credential-proxy capability.

The browser never receives provider credentials, worker addresses, guest
addresses, SSH private keys, or reusable access tokens.

## Architecture

```text
run-on-plue.tsx
  -> Plue SandboxProvider
    -> authenticated Plue workspace create
      -> Microsandbox controller placement
    -> Plue SSH gateway readiness
    -> stage workflow project
    -> run Smithers in the guest
    -> read result and cleanup
```

The Plue control plane remains on GKE Autopilot. A separate private GKE Standard
nested-virtualization cluster hosts Microsandbox workers. Public terminal, SSH,
and preview traffic terminates at Plue gateways and is fenced by placement
generation.

## Deliverables

1. A real `createPlueSandboxProvider` implementation with no product-code mock.
2. `.smithers/workflows/run-on-plue.tsx` and its separate implementation workflow.
3. Documentation and generated llms bundles.
4. Redacted real-backend evidence covering create, exec, result parsing, and cleanup.

## Verification

- Create a workspace against a real Plue environment configured with an
  authenticated Microsandbox controller.
- Execute the example child workflow and prove real model output and run events.
- Exercise terminal attach, cold resume, disk snapshot, and delete on real nested KVM.
- Prove a sentinel secret is absent from durable state, output, logs, snapshots,
  process arguments, and provider metadata.
- Prove cleanup leaves no workspace, guest, allocation, or cleanup-pending record.

CI-safe tests may cover deterministic mapping and parsing, but they do not satisfy
the release gate. The gate requires the real backend described above.
