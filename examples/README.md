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
