/**
 * `node:fs` confined under a host directory, exposed as a `SyncFsLike` whose
 * namespace root is that directory: slice path `/x` ↔ `<hostRoot>/x`.
 *
 * This is the test-side stand-in for a ZenFS mount — ZenFS is born rooted at
 * `/`, `node:fs` is not — and doubles as a second structural conformance check
 * on the slice (the raw `typeof import("node:fs")` being the first).
 */
import * as fs from "node:fs"
import { join } from "node:path"
import type { SyncFsLike } from "../src/browser/WasiFs.ts"

export const rootedSyncFs = (hostRoot: string): SyncFsLike => {
  const at = (path: string): string => join(hostRoot, path)
  return {
    openSync: (path, flags, mode) => fs.openSync(at(path), flags, mode),
    closeSync: (fd) => fs.closeSync(fd),
    readSync: (fd, buffer, offset, length, position) => fs.readSync(fd, buffer, offset, length, position),
    writeSync: (fd, buffer, offset, length, position) => fs.writeSync(fd, buffer, offset, length, position),
    fstatSync: (fd) => fs.fstatSync(fd),
    ftruncateSync: (fd, length) => fs.ftruncateSync(fd, length),
    futimesSync: (fd, atime, mtime) => fs.futimesSync(fd, atime, mtime),
    statSync: (path) => fs.statSync(at(path)),
    lstatSync: (path) => fs.lstatSync(at(path)),
    mkdirSync: (path) => fs.mkdirSync(at(path)),
    readdirSync: (path, options) => fs.readdirSync(at(path), options),
    renameSync: (from, to) => fs.renameSync(at(from), at(to)),
    unlinkSync: (path) => fs.unlinkSync(at(path)),
    rmdirSync: (path) => fs.rmdirSync(at(path)),
    readlinkSync: (path) => fs.readlinkSync(at(path)),
    // The link target is content, not a location: stored verbatim so the wasm
    // side reads back exactly the namespace path it wrote.
    symlinkSync: (target, path) => fs.symlinkSync(target, at(path)),
    utimesSync: (path, atime, mtime) => fs.utimesSync(at(path), atime, mtime),
    truncateSync: (path, length) => fs.truncateSync(at(path), length)
  }
}
