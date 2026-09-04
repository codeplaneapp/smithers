---
title: "The browser host contract"
description: "What BrowserHost guarantees where it diverges from NodeHost: the filesystem options a mounted volume honours, the operations it refuses, and the spawner's one-run-at-a-time abort boundary."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/platform-browser/docs/contract.md"
---

The [`@smthrs/platform-browser`](/reference/api/) bundle is the only host
whose services are adapters over injected backends rather than over the machine,
so its divergences from `NodeHost` are part of the browser claim. Its
`FileSystem` honours the options a caller can set: a recursive `readDirectory`
is walked here because the promises slice has no recursive `readdir`, `access`
answers `readable` and `writable` from the reported mode bits because a mounted
volume has no user identity, `makeDirectory` forwards `mode`, and `realPath`
canonicalizes rather than echoing its input, which matters because
`@smthrs/kernel` resolves every guarded path through it before checking the
grant. Operations the slice cannot serve at all, symlink creation and writable
handles and watchers among them, fail with `PermissionDenied` rather than pretending.

Its `ChildProcessSpawner` runs one command at a time behind a permit held until
the interpreter promise settles. Interruption, timeout, and `kill` abort the
interpreter through just-bash's `AbortSignal` and are reported on the handle as
a `PlatformError`, never as an interrupt replayed into the caller's fiber.
