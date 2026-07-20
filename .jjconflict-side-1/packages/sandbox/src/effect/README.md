# effect/

Cluster transport internals:

- `sandbox-entity.js` — the Sandbox Entity RPC contract
  (create/ship/execute/collect/cleanup), the `SandboxEntityExecutor` tag, and
  `makeSandboxTransportServiceEffect`, which drives the entity through
  `Entity.makeTestClient` with a local `ShardingConfig`.
- `http-runner.js` — Docker and Codeplane executor layers, plus the
  `SandboxHttpRunner` re-export.
- `socket-runner.js` — Bubblewrap executor layer (with macOS `sandbox-exec`
  fallback), plus the `SandboxSocketRunner` re-export.
- `process-runner.js` — shared pieces: the allowlisted runner env,
  `spawnSandboxCommand`, `makeBaseSandboxHandle`, config normalization, and
  the bwrap/sandbox-exec/docker argument builders that encode the isolation
  policy.

Isolation invariants: the request dir is mounted read-only at `/workspace`
and the result dir writable at `/result`; user volumes may never shadow
either; no-network is the default (`--unshare-net` / `--network none` /
`(deny network*)`).

Consumers: `../transport.js` wraps these layers into `SandboxTransport`;
`packages/engine/src/effect/workflow-bridge.js` re-exports the entity,
runners, and executor layers — renames here are breaking.

Gotchas: the Codeplane executor is a local stub (execute always fails,
pending the remote worker integration); a docker `run --rm` container can
outlive a cancelled CLI client (see the note in `http-runner.js`).
