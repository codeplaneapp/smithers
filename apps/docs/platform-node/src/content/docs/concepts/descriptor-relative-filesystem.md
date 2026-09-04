---
title: "The descriptor-relative filesystem"
description: "Why AtomicFileSystem runs every filesystem operation through a CPython helper, what confinement that buys, which operations it covers, and what it costs per call."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/platform-node/docs/concepts/descriptor-relative-filesystem.md"
---

`AtomicFileSystem` is `NodeHost`'s filesystem slot, and it is not Effect's
`NodeFileSystem`. It exists to close one race.

## The race it closes

A capability check names a path. A path-based operation resolves that path
again when it runs. Between the two, anything with write access to the
workspace can replace a component of the path with a symlink, and the operation
that was authorized for one file performs on another.

POSIX has the answer: open a directory, keep the descriptor, and perform the
final syscall relative to it (`openat(2)`, `renameat(2)`, and the `dir_fd`
family). A descriptor names an inode, not a name, so a swap after the walk
cannot redirect anything.

Node's JavaScript filesystem API exposes none of that, and no root-handle
equivalent. So `AtomicFileSystem` delegates each operation to a small CPython 3
helper that does have it. The helper opens the workspace root once, walks every
component with `O_NOFOLLOW`, and performs the operation relative to the pinned
parent descriptor.

## What the helper refuses

The confinement rules are strict, and two of them surprise people:

- **A regular file with more than one hard link cannot be opened.** A hard link
  is not a symlink, so `O_NOFOLLOW` cannot confine it: the same inode is
  reachable from outside the workspace under another name. Refusing the open is
  the only confinement available.
- **A symlink is never traversed, opened, renamed, or removed.** Directory
  listing is the single exception. It names a symlink entry and never descends
  through it, because listing resolves nothing and refusing would buy no
  confinement.

Two more rules follow from requiring the kind on the descriptor rather than on
a name:

- **Only regular files carry content.** A FIFO, a socket, a device, or a
  directory is refused for every read and write, because the kind is checked on
  the already-open descriptor and cannot be swapped afterwards.
- **Every open is non-blocking.** A named pipe planted at a path cannot park
  the adapter inside `open()` until some other process opens the other end. A
  write-only open of a reader-less pipe returns a typed failure instead. Node's
  own filesystem waits there indefinitely, which is the one place this adapter
  is deliberately stricter than the implementation it mirrors.

The workspace root itself is addressable like any other directory: `exists`,
`stat`, `readDirectory`, `realPath`, `glob`, and a recursive `makeDirectory`
all answer for it. Removing it, renaming it or onto it, reading it as a file,
writing over it, and a non-recursive `makeDirectory` on it stay refused.

## Which operations it covers

Thirteen operations can be expressed as one descriptor-relative request, and
those are the ones the adapter implements:

```text
readFile  readFileString  writeFile  writeFileString  exists  stat
readLink  realPath  makeDirectory  readDirectory  remove  rename  glob
```

Everything else on Effect's `FileSystem` surface returns a live handle or a
stream that Node cannot open relative to a pinned descriptor: `open`, `stream`,
`sink`, `watch`, `copy`, `copyFile`, `link`, `symlink`, `access`, `chmod`,
`chown`, `truncate`, `utimes`, and the `makeTemp*` family. Under the kernel
decorator each of those fails closed with a typed `PermissionDenied` rather
than silently reverting to a path-based call. A program that needs them reaches
for the raw `NodeHost.NodeFileSystem` outside the capability boundary.

Wrapping that raw layer directly also fails closed, because it carries no
atomic extension for the kernel to call.

## Why an interpreter, and why that one

The helper is CPython 3 because it is the shortest path to `dir_fd` on a POSIX
host that already has one installed. Three properties of how it is started are
load-bearing:

- **Absolute path, never a `PATH` lookup.** Python's `-I` isolates the
  interpreter only after one has been chosen. A `python3` planted in the
  working directory or on an injected `PATH` would already have executed
  arbitrary code inside the process that holds the pinned root descriptor.
- **Isolated mode (`python3 -I`).** The host's working directory,
  `PYTHONPATH`, and the user site directory stay off the module search path, so
  a `base64.py` written into the very workspace the adapter is confining cannot
  be imported. The trade-off is that `PYTHONHOME` is ignored too: an
  interpreter that needs it fails closed like any other unusable helper.
- **UTF-8 pinned (`-X utf8`).** The request, the response, and the filesystem
  encoding are all UTF-8, so a host started under a legacy locale addresses the
  same file and writes the same bytes as one started under a UTF-8 locale.

Both directions of the protocol are length-framed and bounded, so neither a
large file nor a malfunctioning helper can make the host allocate without
limit. See
[Configure the filesystem helper](/guides/configure-the-filesystem-helper/)
for the ceilings and how to change them.

## What it costs

Every operation is one CPython fork, roughly 130 ms on a current host. That is
the price of descriptor-relative confinement on a runtime with no `openat`, and
it shapes how you should call it:

- Prefer one recursive `readDirectory` (one fork for the whole tree) to a read
  per entry.
- Batch a wide fan-out. Without a ceiling, an
  `Effect.forEach(files, read, { concurrency: "unbounded" })` over fifty paths
  would start fifty interpreters at once, which is why the adapter carries a
  process ceiling at all.

## Errors

Errno is normalized to the same reasons `@effect/platform-node` reports, so a
caller reads the same typed reason it would get from the native filesystem,
with one addition: a helper failure that carries no errno at all stays
`PermissionDenied`, so the boundary fails closed.

Writes follow Effect's `OpenFlag` contract exactly (`r`, `r+`, `w`, `wx`, `w+`,
`wx+`, `a`, `ax`, `a+`, `ax+`), and the test suite checks each flag against the
native Node filesystem. Truncation runs on the opened descriptor rather than
through `O_TRUNC`, so a hard link is refused before the file is modified.

`remove(path, { recursive: true })` walks iteratively with an explicit
descriptor stack, bounded at 512 levels deep and 100000 entries visited. One
directory's names are read before any of its entries is unlinked, because
unlinking from a directory while iterating it is undefined. Progress is partial
on refusal: entries already unlinked stay unlinked. `force: true` succeeds for
a path whose ancestors do not exist, exactly as `fs.rm` does.
