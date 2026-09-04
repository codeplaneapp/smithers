# Runnable examples

Run `pnpm run check` and `pnpm run test -- --run` in this directory. Live model
examples require explicit opt-in with `SMITHERS_LIVE_EXAMPLES=1`.

## Host containment

`src/37-host-containment.ts` starts a host, kills it, and verifies that its
replacement reaps the abandoned process group. The runtime creates the SQLite
parent directory, which may also be the host's repository root. The jj version
probe can run before that directory exists.

The companion `src/37-host-containment-host.ts` prints its process group id only
after recording the child durably. Startup failures print the Effect cause to
stderr and exit with status 1. The example summary includes `hostStderr`, which
is empty on successful startup.
