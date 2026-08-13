# Running Smithers inside a real stereOS VM

This directory boots actual stereOS mixtapes and runs a Smithers `<Sandbox>`
body inside them. Nothing here is simulated: the two transcripts are captured
output from runs recorded on 2026-08-12, and tab 3 of
https://stereos.smithers.sh renders them from these files.

| Host | Mixtape | Hypervisor | Result |
| --- | --- | --- | --- |
| Apple Silicon Mac | `coder-arm64:latest`, pulled | Apple Virtualization.framework via `mb` | `finished`, sandbox node 557 ms |
| GCE n2-standard-2, nested virt | `coder-dev` x86_64, built from source | QEMU/KVM | `finished`, sandbox node 1183 ms |

| File | What it is |
| --- | --- |
| `stereos-provider.ts` | The provider. `createCommandSandboxProvider` from `smthrs/sandbox` plus an SSH `SandboxSession`. |
| `guest-runner.sh` | The in-guest entry runner. POSIX shell, because mixtapes ship no Bun or Node. |
| `stereos-real.tsx` | The workflow: one `<Sandbox>` whose provider is the above. |
| `child-workflow.tsx` | The child workflow the sandbox boundary carries. |
| `jcard.toml` | The masterblaster VM spec. |
| `bootstrap-vm.sh` | Installs the stereos key for the guest `agent` user and prints the provider env. |
| `provision-linux-host.sh` | Turns a fresh nested-virt Linux box into a stereOS execution host. |
| `run-on-linux-host.sh` | Boots the built x86_64 image under QEMU/KVM and runs the workflow. |
| `transcript.txt` | The recorded macOS run, rendered on the site. |
| `transcript-linux.txt` | The recorded GCE/KVM run, rendered on the site. |

## Recipe (Apple Silicon)

```sh
brew install qemu zstd
curl -fsSL https://mb.stereos.ai/latest/darwin/arm64/mb -o ~/.local/bin/mb && chmod +x ~/.local/bin/mb
mkdir -p ~/.config/stereos && ssh-keygen -t ed25519 -f ~/.config/stereos/ssh-key -N ""
```

Then populate the local mixtape store. `mb pull coder-arm64:latest` **fails**
today (see "Registry defect" below), so fetch the qcow2 manifest by hand and
convert it to the raw image Apple's hypervisor needs:

```sh
REG=https://download.stereos.ai/v2/mixtapes/coder-arm64
DEST=~/.config/mb/mixtapes/coder-arm64/latest && mkdir -p "$DEST"
# digests come from the qcow2 manifest in the OCI index at $REG/manifests/latest
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
```

`sha256 "$DEST/stereos.img"` must equal
`6b8ba3e7113988318ebbc3887c71835db5e2e33a6e8c9264e57e8bd84de786ce`, the raw
digest `mixtape.toml` declares. It does, which is what proves the mixtape
content is fine and only the raw blob transport is broken.

Boot and run:

```sh
cd apps/stereos-site/real
mb up                                    # ~7s to a booted VM
eval "$(./bootstrap-vm.sh)"              # keys the agent user, exports STEREOS_SSH_*
env -u ANTHROPIC_API_KEY bun ../../../apps/cli/src/index.js up stereos-real.tsx \
  --input '{"prompt":"hello from the host"}' -d
```

## Why the entry runner is a shell script

The provider kit hands the entry command `SMITHERS_SANDBOX_REQUEST_PATH` and
`SMITHERS_SANDBOX_RESULT_PATH` and accepts result JSON on either stdout or the
result file. The usual entry is `bun run-smithers-sandbox.js`, but no mixtape
carries Bun or Node, so that binary does not exist in the guest.

Of the options — cross-compile a runner with `bun build --compile`, run the
agent harness as the entry, or write a dependency-free script — this uses the
script. It needs nothing that is not already in `stereos.agent.basePackages`
(coreutils, `jq`, `sha256sum`), it is readable on the site as evidence, and it
disappears entirely the day a `smithers-mixtape` ships with Bun baked in.

One sharp edge worth recording: the first version probed the restriction model
with `: >/etc/probe 2>/dev/null`. A redirection failure on a POSIX *special
builtin* (`:`) exits a non-interactive shell, so the runner died before writing
a result. The probe now runs in a subshell.

## Linux host with KVM

`provision-linux-host.sh` installs QEMU/KVM, Nix, and Bun and builds the
x86_64 `coder-dev` mixtape from source. A source build is unavoidable there:
the registry publishes `coder-arm64` only, and `mb mixtapes list coder-x86`
returns no tags.

The build takes about 25 minutes on 2 vCPU and produces a 1.01 GiB qcow2. The
`-dev` profile bakes `~/.config/stereos/ssh-key.pub` in for both `admin` and
`agent`, so this path needs no `bootstrap-vm.sh` step.

Four things that cost time and are easy to avoid:

- Install Determinate Nix **with** its systemd init. `--init none` leaves the
  multi-user store without a daemon and every build fails on
  `opening lock file "/nix/var/nix/db/big-lock": Permission denied`.
- `make` is not in a default Debian 12 image.
- The built image lives read-only in the Nix store, so boot a
  `qemu-img create -b` overlay rather than the store path.
- Mixtapes boot through GRUB under UEFI. Without OVMF pflash drives QEMU's
  default SeaBIOS never hands off and the serial log stays empty with no error.

Reference host: `stereos-smithers-demo`, n2-standard-2, 100 GB pd-balanced,
us-east1-b, project `plue-prod-1771780303`, `--enable-nested-virtualization`.
About $81/month at list price. No inbound rules beyond the VPC default SSH; no
gateway is exposed and nothing anonymous can trigger a run.

## Registry defect

`mb pull coder-arm64:latest` fails reproducibly with
`decompressing stereos.img.zst: corrupt stream, did not find end of stream`.
It is not `mb` and not the network:

- The registry serves the raw blob at its full declared length (752,461,648 B)
  and stable bytes across fetches, but its sha256 is
  `d335283a5c0c9fdeef22fe48740cb74d0c973b69373bef651e76aaac012a21e2`, not the
  `bf212e026f722ccccd30f273d363f9b8a7245516f7bc1e8d81db67b41245cdeb` that both
  `mixtape.toml` and the `docker-content-digest` response header declare.
- `zstd -t` on it reports `Decoding error (36): Data corruption detected`.
- The qcow2 blob at the same tag matches its digest exactly, and the raw image
  reconstructed from it matches the declared *uncompressed* raw digest.

So one artifact was corrupted after digesting, at publish time.

## Integration gaps

Numbered to continue tab 1 §8, which listed five.

6. **`mb` keys only the admin user.** `mb up` injects an SSH key over the
   stereosd control plane, but writes it to `/home/admin/.ssh/authorized_keys`
   only. The `agent` user — the one an orchestrator should target — gets
   nothing, so `bootstrap-vm.sh` has to install a key through the admin
   channel. Should `jcard.toml` carry authorized keys per user?
7. **The restriction model is shell-deep, not user-deep.** The restricted PATH
   comes from `stereos-agent-shell`, the agent's login shell. A non-interactive
   `ssh agent@host 'command'` bypasses it and sees the full system profile:
   the run below reports `nixCli: on PATH`. Filesystem restrictions do hold
   (`writeOutsideWorkspace: denied`). Any host-facing exec API needs to apply
   the restriction at the exec layer, not the login shell.
8. **No x86_64 mixtape is published.** `coder-x86` exists in the registry with
   no tags, which forces every Linux/KVM host onto a from-source Nix build.
9. **The raw blob for `coder-arm64:latest` is corrupt** (above). Republishing
   it makes `mb pull` work and deletes this README's whole manual-fetch
   section.

## What the runs reported

macOS host, pulled `coder-arm64` mixtape:

```
summary            ran inside stereOS as agent@coder on Linux 6.12.74 aarch64
prompt             hello from the host
promptSha256       0d7c0ab02bab7f556b0de496bccbb2c99daa7c8aa7be3af9797d3aa8e1a170d5
guest              stereOS 2026.03.04.0, Linux 6.12.74 aarch64, agent@coder, 4 cpus, 3.8 GiB
restrictions       writeOutsideWorkspace=denied, writeInsideWorkspace=allowed,
                   nixCli=on PATH, nixStorePresent=yes
harnessesOnPath    claude opencode gemini
```

GCE/KVM host, `coder-dev` x86_64 mixtape built on the box:

```
summary            ran inside stereOS as agent@coder-dev on Linux 6.18.33 x86_64
prompt             hello from the linux host
promptSha256       b626119e7fd00e1ddbc4c11525b2081af555d3743974490ccaea1df96d228121
guest              stereOS dev-f269d96, Linux 6.18.33 x86_64, agent@coder-dev, 2 cpus, 2.8 GiB
restrictions       writeOutsideWorkspace=denied, writeInsideWorkspace=allowed,
                   nixCli=on PATH, nixStorePresent=yes
harnessesOnPath    claude opencode gemini
```

In both runs `promptSha256` is computed in the guest and matches
`printf '%s' '<the prompt>' | shasum -a 256` on the host, which is what makes
the output traceable to the VM rather than to whoever wrote this file.
