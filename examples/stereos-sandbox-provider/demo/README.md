# The stereos.smithers.sh demo service

What runs on the GCE host `stereos-smithers-demo` (n2-standard-2, us-east1-b,
nested virtualization) so that the Live demo tab drives real stereOS VMs.

Prepare the host first with `../real/provision-linux-host.sh`, which installs
QEMU/KVM, Nix, and Bun and builds the `coder-dev` x86_64 mixtape. Then:

```sh
CLOUDFLARE_API_TOKEN=… ./install.sh
```

## Units

| Unit | What it does |
| --- | --- |
| `stereos-vm.service` | Boots the mixtape under QEMU/KVM through `boot-vm.sh` and keeps it up. The VM is sticky: every demo run reuses it, so a run pays SSH and guest execution only. Installs the guest Bun runtime on first boot. |
| `stereos-gateway.service` | A Smithers gateway bound to `127.0.0.1:7331`, serving the workspace at `~/stereos-demo` where the three demo workflows live. Requires a bearer token even on loopback; the token is in `/etc/stereos-demo.env`, mode 0600, root-owned. |
| `stereos-guard.service` | `guard.ts` on `127.0.0.1:8787`. The only thing published. Serves the bundled run UI and four API routes. |
| `stereos-tunnel.service` | `tunnel.sh`: a cloudflared tunnel from the guard outward, so the host opens no inbound port. Publishes its own hostname to the `_stereos-api.smithers.sh` TXT record. |

All four are enabled, so the stack returns after a reboot.

## The guard

`guard.ts` is the security boundary. The gateway's full RPC surface (hijack,
browser sessions, cron, arbitrary workflow launch, run diffs, host paths) is not
reachable from the internet. The guard exposes:

| Route | Effect |
| --- | --- |
| `GET /api/health` | Capacity and queue depth. |
| `POST /api/runs` | Launch one of three allowlisted workflows with server-chosen input. Returns a run id and a per-run token. |
| `GET /api/runs/:id` | A hand-built projection: status, node labels and statuses, elapsed time, and the child workflow's own output. |
| `POST /api/runs/:id/approval` | Resolve the approval gate. Requires the run's token. |

Enforced:

- Only `hello`, `pipeline`, and `approval-demo` may launch, and only with input
  the guard chooses. A workflow id from the request is never forwarded.
- The gateway method name is never taken from a request. Five methods are
  reachable in total, all named as literals in `guard.ts`, and every one of them
  is called.
- At most two concurrent runs, with a queue of eight and a visible position.
- Six starts per IP per ten minutes.
- Approval requires the 256-bit token minted at start, compared with
  `timingSafeEqual`.
- Runs are cancelled at five minutes and their slot is freed.
- Responses are built field by field. Engine rows are never spread into a
  response, so workflow paths, config, and env cannot leak.
- Non-GET requests never reach the static file handler, so a request shaped like
  `POST /v1/rpc/<method>` is a 404 rather than an SPA response.

## Discovery

The page prefers `https://stereos-api.smithers.sh`. Creating that named tunnel
needs a Cloudflare API token carrying `Cloudflare Tunnel: Edit`; until then
`tunnel.sh` runs a quick tunnel and writes its current hostname to the
`_stereos-api.smithers.sh` TXT record, which the page resolves over
DNS-over-HTTPS. The record holds a hostname only. It grants nothing on its own,
because the guard is the entire public surface.

To switch to the named tunnel, write `/etc/stereos-tunnel.json` as
`{"token":"<tunnel token>"}` and restart `stereos-tunnel.service`.

## Workflows

`workflows/*.tsx` run on the host; each `<Sandbox>` body runs in the guest
through `stereos-provider.ts`, which is `real/stereos-provider.ts` with the
guest entrypoint lifted into a parameter. The guest modules are `guest-*.tsx`;
they share `guest-facts.ts`, which reports the values the page shows as proof of
in-guest execution.

`approval-demo` reads its own gate decision with `ctx.outputMaybe` and sets
`skipIf` on the sandbox, so a denial runs nothing in the VM.

## Latency

Measured on the reference host, 2026-08-13:

| | |
| --- | --- |
| Cold boot to guest sshd | 25 s |
| Cold boot to a finished run | 29 s |
| First run after a cold boot | 4.2 s |
| Warm run, public HTTPS to finished | 2.2 - 4.1 s |
| Sandbox node alone | 1.9 - 2.3 s |

A demo run does not pay a kernel boot: `stereos-vm.service` keeps the guest up
and every run reuses it, so the cold numbers apply only after a host reboot or
a unit restart.
