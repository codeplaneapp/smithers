# @smithers-orchestrator/microsandbox

First-class Smithers `SandboxProvider` for local Microsandbox microVMs. The
package maps the shared `SandboxSession` seam onto the `microsandbox` TypeScript
SDK. Request/result serialization, egress env, redaction, and result parsing
remain in `@smithers-orchestrator/sandbox`'s provider kit.

## Exports

- `createMicrosandboxSandboxProvider(options?)`
- `registerMicrosandboxSandboxProvider(options?)`
- `createMockMicrosandboxEnvironment(handler, faults?)`
- `MICROSANDBOX_PROVIDER_ID`, equal to `"microsandbox"`

## Defaults

- image: `oven/bun:1`
- workdir: `/workspace`
- command: `bun /workspace/run-smithers-sandbox.js`
- shell: `/bin/sh`
- cleanup: `destroy`
- non-sticky name conflicts: replace the old sandbox

The runner must already exist in the image or be supplied with `setupFiles`.
The SDK is an optional dependency and is imported only when the provider opens
a session. The provider creates the workdir after boot instead of requiring the
selected image to contain `/workspace` already.

## Lifecycle

Ephemeral sandboxes stop and remove state during cleanup. A sticky
`workspace.name` reconnects to a running sandbox or starts a stopped sandbox,
then stops without removing its writable layer. `cleanup: "keep"` creates or
starts detached and leaves the microVM running.

See `docs/integrations/microsandbox-sandbox-provider.mdx` for the full public
contract and host requirements.
