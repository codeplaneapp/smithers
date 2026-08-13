# Running Smithers inside a real stereOS VM

This directory boots actual stereOS mixtapes and runs the bundled Smithers
`<Sandbox>` child workflow inside them. The two transcripts are raw terminal
captures from runs recorded on 2026-08-12. The Real stereOS tab at
https://stereos.smithers.sh renders those files directly.

| Host | Mixtape | Hypervisor | Result |
| --- | --- | --- | --- |
| Apple Silicon Mac | `coder-arm64:latest`, fetched by hand (see Registry defect) | Apple Virtualization.framework through `mb` | `finished`; timing is in `transcript.txt` |
| GCE n2-standard-2 with nested virtualization | `coder-dev` x86_64, built from source | QEMU/KVM | `finished`; timing is in `transcript-linux.txt` |

| File | Purpose |
| --- | --- |
| `stereos-provider.ts` | `createCommandSandboxProvider` plus an SSH `SandboxSession`; bundles and uploads the child workflow. |
| `guest-runner.sh` | Thirteen-line guest launcher that invokes Bun. It does not construct results. |
| `child-workflow.tsx` | Real guest work: facts, restriction probes, prompt consistency hash, and a prime sieve. Bun writes all result JSON with `JSON.stringify`. |
| `stereos-real.tsx` | Host workflow containing one `<Sandbox>`. |
| `bootstrap-vm.sh` | Keys the arm64 guest and copies the pinned Bun musl runtime into it. |
| `provision-linux-host.sh` | Prepares a fresh nested-virtualization Linux host and builds the x86_64 mixtape. |
| `run-on-linux-host.sh` | Checks KVM access, boots QEMU, copies x86_64 Bun into the guest, and runs Smithers from source. |
| `transcript.txt`, `transcript-linux.txt` | Unedited command/output captures rendered on the site. |

## Apple Silicon recipe

Install the host tools and use the explicit `mb` path. `~/.local/bin` need not
already exist or be on `PATH`.

```sh
brew install qemu zstd
mkdir -p "$HOME/.local/bin" "$HOME/.config/stereos"
curl -fsSL https://mb.stereos.ai/latest/darwin/arm64/mb -o "$HOME/.local/bin/mb"
chmod +x "$HOME/.local/bin/mb"
test -f "$HOME/.config/stereos/ssh-key" || \
  ssh-keygen -t ed25519 -f "$HOME/.config/stereos/ssh-key" -N ""
```

`mb pull coder-arm64:latest` currently fails. Fetch the clean qcow2 blob and
the remaining manifest objects, then convert the qcow2 image to raw:

```sh
REG=https://download.stereos.ai/v2/mixtapes/coder-arm64
DEST="$HOME/.config/mb/mixtapes/coder-arm64/latest"
mkdir -p "$DEST"
curl -fsSL "$REG/blobs/sha256:2cc5b9dd3b3a27e891aef218156a701200c3654adf0df5db258a828fa6a2527d" \
  | zstd -d -o "$DEST/stereos.qcow2"
qemu-img convert -f qcow2 -O raw "$DEST/stereos.qcow2" "$DEST/stereos.img"
for d in 65484645bb276f557635de6757abae2080e002c979afdcf1602a7c3c20f3eecd:bzImage \
         2c7d77b38353ce630296f8d3c94cf0c2588c438d0c0f0dfe34ada415e6ac4fb1:initrd \
         145af2f7943439a5083410b550c441c8095ea5087d54f28fbf03caf5104e00c6:cmdline \
         0e33109de96b56886b68f3230443633a9a3aa66166d319384a5fc43c39c5e0b7:init \
         c89c84a26e66ee37eb7f7321e31126b485b4b4a6d123839c49f09f84f2298645:mixtape.toml; do
  curl -fsSL "$REG/blobs/sha256:${d%%:*}" -o "$DEST/${d##*:}"
done
EXPECTED=6b8ba3e7113988318ebbc3887c71835db5e2e33a6e8c9264e57e8bd84de786ce
ACTUAL=$(shasum -a 256 "$DEST/stereos.img" | awk '{print $1}')
test "$ACTUAL" = "$EXPECTED" && printf 'digest verified: %s\n' "$ACTUAL" || {
  printf 'digest mismatch: expected %s, got %s\n' "$EXPECTED" "$ACTUAL" >&2
  exit 1
}
```

Boot, install the guest runtime, and run the source CLI:

```sh
cd apps/stereos-site/real
"$HOME/.local/bin/mb" up
eval "$(MB="$HOME/.local/bin/mb" ./bootstrap-vm.sh)"
env -u ANTHROPIC_API_KEY bun ../../../apps/cli/src/index.js up stereos-real.tsx \
  --input '{"prompt":"hello from the host"}'
```

## Bun inside the guest

Mixtapes contain no Bun or Node runtime. Both host scripts download the pinned
official Bun 1.2.21 musl archive for the guest architecture. NixOS also lacks
the generic musl loader path, so the scripts copy the loader and the matching
Alpine `libstdc++` and `libgcc` files into `/home/agent/.local` and install a
small wrapper. The arm64 and x86_64 guests both report Bun 1.2.21.

The provider bundles the exact `child-workflow.tsx` module with `Bun.build`,
uploads it beside the provider request, and runs `guest-runner.sh`. That script
only validates the runtime and bundle paths before invoking Bun. Bun reads the
request, executes `executeGuestWork`, and writes the complete result with
`JSON.stringify`. `jqOnPath: true` confirms the mixtapes include `jq`, but jq is
not needed for result construction. Strings with quotes, backslashes, newlines,
tabs, and control characters remain valid JSON.

## Fresh Linux/KVM host

The reference host is `stereos-smithers-demo`, n2-standard-2, 100 GB
pd-balanced, `us-east1-b`, project `plue-prod-1771780303`, with nested
virtualization enabled. No gateway or anonymous run endpoint is exposed.

First obtain this example at the pinned engineering commit:

```sh
git clone https://github.com/smithersai/smithers.git "$HOME/smithers"
git -C "$HOME/smithers" checkout cd58efd6245f829ed16ef960394f651fed661706
cd "$HOME/smithers"
```

Prepare and run the host:

```sh
./apps/stereos-site/real/provision-linux-host.sh
pnpm install --frozen-lockfile
cd apps/stereos-site/real
./run-on-linux-host.sh
```

`provision-linux-host.sh` installs QEMU/KVM, Nix, Bun, pnpm, and build tools,
then builds `coder-dev` x86_64 from source. The published registry has no
x86_64 tag. The script verifies read and write access to `/dev/kvm`; after
adding the user to `kvm`, it re-enters through `sg kvm` so the current run gets
the new supplementary group. `run-on-linux-host.sh` performs the same check
before QEMU starts.

The build takes about 25 minutes on 2 vCPU and produces a 1.01 GiB qcow2. It
needs Determinate Nix with systemd initialization, `make`, a copy-on-write
overlay over the read-only Nix store image, and OVMF pflash drives for GRUB.

## Registry defect

`mb pull coder-arm64:latest` fails with
`decompressing stereos.img.zst: corrupt stream, did not find end of stream`.
The registry returns 752,461,648 stable bytes with sha256
`d335283a5c0c9fdeef22fe48740cb74d0c973b69373bef651e76aaac012a21e2`.
The manifest and response header declare
`bf212e026f722ccccd30f273d363f9b8a7245516f7bc1e8d81db67b41245cdeb`.
`zstd -t` reports `Decoding error (36): Data corruption detected`.

The qcow2 blob at the same tag matches its digest, and converting it produces
the declared uncompressed raw digest shown above. Republishing the one raw
blob makes `mb pull` work. This is a narrow registry artifact issue, not an
image-content or `mb` defect.

## Integration gaps

6. `mb up` injects the host key for `admin`, not `agent`. The bootstrap uses a
   fixed remote `tee` command and sends the public key through stdin.
7. The restricted PATH comes from the agent login shell. Non-interactive SSH
   sees the system profile and reports `nixCli: on PATH`; filesystem writes
   outside the workspace remain denied.
8. The registry publishes no x86_64 mixtape, so Linux/KVM requires a source
   build.
9. The raw arm64 blob needs republishing as described above.
10. A mixtape with Bun already present would remove the runtime copy step.

## Reading the evidence

Both runs report the child workflow marker, Bun version and architecture,
guest OS and kernel, restriction probes, a prompt-derived prime computation,
the full provider run ID, and the sandbox ID. The event listing gives the exact
`SandboxCreated` to `SandboxCompleted` timing.

`promptSha256` is consistency evidence only. The same prompt produces the same
hash on any machine, so the hash does not prove provenance or guest execution.
The captures do not claim attestation. They show the exact executable commands,
the Smithers event lifecycle, and the result returned through the guest
request/result transport. The source and raw captures are committed together
so those claims can be audited.
