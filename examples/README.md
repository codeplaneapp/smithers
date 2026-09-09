# Runnable examples

Run `pnpm run check` and `pnpm run test -- --run` in this directory. Live model
examples require explicit opt-in with `SMITHERS_LIVE_EXAMPLES=1`. An ambient
provider key or a running Ollama daemon never selects them on its own.

To run a live test from this directory:

```sh
# Also requires OPENAI_API_KEY in the environment.
SMITHERS_LIVE_EXAMPLES=1 pnpm exec vitest run test/12-agent-live-smoke.test.ts

# Requires Ollama at localhost:11434 and ollama pull qwen2.5:7b.
SMITHERS_LIVE_EXAMPLES=1 pnpm exec vitest run test/13-agent-live-smoke-local.test.ts
```

Both tests allow 300 seconds for model work. Without opt-in they report skipped
with their requirements in the test titles. The OpenAI test also skips without
a key; the local test reports a skip reason if its daemon or model is missing.

## Host containment

`src/37-host-containment.ts` starts a host, kills it, and verifies that its
replacement reaps the abandoned process group. The runtime creates the SQLite
parent directory, which may also be the host's repository root. The jj version
probe can run before that directory exists.

The companion `src/37-host-containment-host.ts` prints its process group id only
after recording the child durably. Startup failures print the Effect cause to
stderr and exit with status 1. The example summary preserves `hostStderr`,
including Node runtime warnings such as Node 22's SQLite experimental notice.

## Sandbox filesystem tools

`src/25-agent-tools-in-sandbox.ts` exposes only `read` and `write`, with
capabilities restricted to the scratch root. Tool paths are relative to that
root. The host filesystem service rejects absolute paths, `..` components,
symlinks (including dangling links), and hard-linked files. Nested file creation
and replacement remain supported. Root names cannot contain capability glob
characters (`*` or `?`).

The host must exclusively own the scratch tree during the run. Path checks do
not provide an OS boundary against another host process racing filesystem
mutations. QuickJS bounds cell evaluation; the supplied host service confines
tool access. The optional third `main` argument supplies a model for exercising
other cells; the default model is scripted and requires no API key.
