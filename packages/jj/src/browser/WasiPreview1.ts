/**
 * A WASI preview 1 host shim over a {@link WasiFs.SyncFsLike} slice.
 *
 * This is the syscall layer under the wasm build of jj: the `flows_jj.wasm`
 * reactor imports `wasi_snapshot_preview1`, and this module answers those
 * imports from a synchronous filesystem slice — ZenFS's sync surface in a
 * browser page, `node:fs` in tests. It is written by hand in this repository
 * (the codebase pattern is structural slices passed as arguments, not an npm
 * runtime dependency); `@bjorn3/browser_wasi_shim` is prior art it mirrors in
 * shape, not a dependency.
 *
 * The shim is deliberately testable without any wasm module: {@link make}
 * returns plain functions over `(memory, fs, fd table)` state, so a test can
 * construct a `WebAssembly.Memory`, call the syscalls directly, and assert
 * errno values and memory layouts.
 *
 * One preopen is exposed: fd 3 names `"/"`, mapped to `root` in the slice —
 * exactly what wasi-libc's preopen scan expects, so every absolute path the
 * module opens resolves inside the slice.
 *
 * **Honest divergences** from a kernel WASI host, in the `BrowserFileSystem`
 * tradition of documenting rather than hiding them:
 *
 * - `fd_sync`/`fd_datasync` are no-ops: a synchronous slice is durable the
 *   moment each call returns, so there is nothing left to flush.
 * - `poll_oneoff` reports every subscription complete immediately: clock waits
 *   (jj's lock backoff sleeps) become yields, and a synchronous filesystem is
 *   always ready. Nothing can be genuinely waited on in a single thread.
 * - `path_link` is `notsup`: the slice has no `linkSync`, and the jj code paths
 *   this package exercises never hard-link (the contract suite proves it).
 * - `path_filestat_set_times` always follows symlinks: the slice has no
 *   `lutimesSync`.
 * - `fd_readdir` re-lists the directory on each call and uses the entry index
 *   as the cookie, so a directory mutated *between* two reads of the same
 *   iteration can skip or repeat a name — unobservable from the
 *   single-threaded module this shim hosts, which finishes each iteration
 *   before it mutates.
 * - `sock_*` and `proc_raise` are `notsup`; there are no sockets or signals in
 *   a tab.
 *
 * @since 0.1.0
 */
import type { SyncDirentLike, SyncFsLike, SyncStatsLike } from "./WasiFs.ts"

/**
 * WASI preview 1 errno values, by their spec names. Exported so tests assert
 * numbers against names rather than magic literals.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const Errno = {
  success: 0,
  acces: 2,
  again: 6,
  badf: 8,
  busy: 10,
  exist: 20,
  fault: 21,
  fbig: 22,
  inval: 28,
  io: 29,
  isdir: 31,
  loop: 32,
  mfile: 33,
  nametoolong: 37,
  nfile: 41,
  noent: 44,
  nolck: 46,
  nospc: 51,
  nosys: 52,
  notdir: 54,
  notempty: 55,
  notsup: 58,
  perm: 63,
  pipe: 64,
  range: 68,
  rofs: 69,
  spipe: 70,
  xdev: 75
} as const

/**
 * The wasm module called `proc_exit`. A reactor module must not exit, so the
 * shim turns the call into a thrown error that traps the calling export;
 * `BrowserJj` reports it as a failed operation.
 *
 * @category errors
 * @since 0.1.0
 * @slop
 */
export class WasiExitError extends Error {
  readonly exitCode: number
  constructor(exitCode: number) {
    super(`wasm module called proc_exit(${exitCode})`)
    this.exitCode = exitCode
  }
}

/** Node-style error `code` strings mapped onto WASI errno values. */
const errnoByCode: Record<string, number> = {
  EACCES: Errno.acces,
  EAGAIN: Errno.again,
  EBADF: Errno.badf,
  EBUSY: Errno.busy,
  EEXIST: Errno.exist,
  EFBIG: Errno.fbig,
  EINVAL: Errno.inval,
  EIO: Errno.io,
  EISDIR: Errno.isdir,
  ELOOP: Errno.loop,
  EMFILE: Errno.mfile,
  ENAMETOOLONG: Errno.nametoolong,
  ENFILE: Errno.nfile,
  ENOENT: Errno.noent,
  ENOLCK: Errno.nolck,
  ENOSPC: Errno.nospc,
  ENOSYS: Errno.nosys,
  ENOTDIR: Errno.notdir,
  ENOTEMPTY: Errno.notempty,
  ENOTSUP: Errno.notsup,
  EOPNOTSUPP: Errno.notsup,
  EPERM: Errno.perm,
  EPIPE: Errno.pipe,
  ERANGE: Errno.range,
  EROFS: Errno.rofs,
  ESPIPE: Errno.spipe,
  EXDEV: Errno.xdev
}

const FILETYPE = { unknown: 0, characterDevice: 2, directory: 3, regularFile: 4, symbolicLink: 7 } as const
const OFLAGS = { creat: 1, directory: 2, excl: 4, trunc: 8 } as const
const FDFLAGS = { append: 1 } as const
const FSTFLAGS = { atim: 1, atimNow: 2, mtim: 4, mtimNow: 8 } as const
const LOOKUPFLAGS = { symlinkFollow: 1 } as const
const RIGHTS = { fdRead: 1n << 1n, fdWrite: 1n << 6n } as const
/** Rights are an obsolete capability mask most hosts ignore; grant everything. */
const ALL_RIGHTS = 0xFFFF_FFFF_FFFF_FFFFn

/** Internal control flow: thrown by syscall bodies, returned as an errno. */
class ErrnoError {
  readonly errno: number
  constructor(errno: number) {
    this.errno = errno
  }
}

const fail = (errno: number): never => {
  throw new ErrnoError(errno)
}

/** The Node-style string `code` of a thrown backend error, if it has one. */
const codeOf = (cause: unknown): string | undefined =>
  typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : undefined

/**
 * Milliseconds (with a fractional part carrying microseconds) to WASI
 * nanoseconds. Split at the millisecond so the multiplication never leaves
 * float-exact range: epoch milliseconds fit in 2^53 with room to spare, and
 * the fraction contributes less than 10^6.
 */
const nsOfMs = (ms: number): bigint => {
  const whole = Math.floor(ms)
  return BigInt(whole) * 1_000_000n + BigInt(Math.round((ms - whole) * 1e6))
}

const decoder = new TextDecoder()
const encoder = new TextEncoder()

interface FileFd {
  readonly kind: "file"
  readonly osFd: number
  offset: bigint
  append: boolean
}
interface DirFd {
  readonly kind: "dir"
  readonly nsPath: string
  readonly hostPath: string
  readonly preopen?: string
}
interface StdioFd {
  readonly kind: "stdio"
  readonly input: boolean
  readonly sink: ((text: string) => void) | undefined
}
type FdEntry = FileFd | DirFd | StdioFd

const zeroStats = { size: 0, atimeMs: 0, mtimeMs: 0, ctimeMs: 0 }

/**
 * What the shim serves the module: a synchronous filesystem, the slice of it
 * preopened as the WASI root, and where the module's stdout and stderr go.
 *
 * The filesystem must be *synchronous* because WASI preview 1 syscalls return
 * a value rather than a promise — there is nowhere to await inside an import.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface WasiPreview1Options {
  /** The synchronous filesystem the module's WASI namespace is served from. */
  readonly fs: SyncFsLike
  /**
   * The slice path preopened as the WASI namespace root `"/"`. Defaults to
   * `"/"` — the namespace *is* the slice — which is what a ZenFS mount wants;
   * tests over `node:fs` pass a temp directory here instead.
   */
  readonly root?: string
  /** Receives text the module writes to fd 1. Unset means the text is dropped. */
  readonly onStdout?: (text: string) => void
  /** Receives text the module writes to fd 2 — Rust panic messages arrive here. */
  readonly onStderr?: (text: string) => void
}

/**
 * A WASI preview 1 host: the `imports` object to instantiate a module with,
 * and the {@link WasiPreview1.initialize} call that binds its memory.
 *
 * The two are separate because the shim cannot read the module's memory until
 * the module exists, and the module cannot be instantiated without the
 * imports — so the binding necessarily happens after instantiation.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface WasiPreview1 {
  /**
   * The `wasi_snapshot_preview1` import namespace: instantiate the module with
   * `{ wasi_snapshot_preview1: shim.imports }`. Every function returns a WASI
   * errno; backend errors are mapped by their Node-style `code`, and anything
   * without one (a genuine bug) is rethrown into the calling export rather
   * than laundered into an errno.
   */
  readonly imports: { readonly [name: string]: (...args: Array<any>) => number }
  /**
   * Binds the instantiated module's exported memory. Must be called after
   * instantiation and before the module's `_initialize` runs, because
   * `_initialize` may already issue syscalls (environ probing).
   */
  readonly initialize: (memory: WebAssembly.Memory) => void
}

/**
 * Creates a WASI preview 1 host over a synchronous filesystem slice.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (options: WasiPreview1Options): WasiPreview1 => {
  const fs = options.fs
  const hostRoot = options.root ?? "/"
  const hostPrefix = hostRoot === "/" ? "" : hostRoot.replace(/\/+$/, "")

  let memory: WebAssembly.Memory | undefined

  const buffer = (): ArrayBuffer => {
    if (memory === undefined) {
      throw new Error("WasiPreview1: initialize(memory) must be called before the module issues syscalls")
    }
    return memory.buffer
  }
  const view = (): DataView => new DataView(buffer())
  /** A view into wasm memory; the constructor bounds-checks `ptr + len`. */
  const bytes = (ptr: number, len: number): Uint8Array<ArrayBuffer> => new Uint8Array(buffer(), ptr >>> 0, len >>> 0)

  // == fd table

  const fds = new Map<number, FdEntry>()
  fds.set(0, { kind: "stdio", input: true, sink: undefined })
  fds.set(1, { kind: "stdio", input: false, sink: options.onStdout })
  fds.set(2, { kind: "stdio", input: false, sink: options.onStderr })
  fds.set(3, { kind: "dir", nsPath: "/", hostPath: hostPrefix === "" ? "/" : hostPrefix, preopen: "/" })
  let nextFd = 4

  const entryOf = (fd: number): FdEntry => {
    const entry = fds.get(fd >>> 0)
    if (entry === undefined) return fail(Errno.badf)
    return entry
  }
  const fileOf = (fd: number): FileFd => {
    const entry = entryOf(fd)
    if (entry.kind !== "file") return fail(entry.kind === "stdio" ? Errno.spipe : Errno.badf)
    return entry
  }
  const dirOf = (fd: number): DirFd => {
    const entry = entryOf(fd)
    if (entry.kind !== "dir") return fail(Errno.notdir)
    return entry
  }
  const newFd = (entry: FdEntry): number => {
    const fd = nextFd++
    fds.set(fd, entry)
    return fd
  }

  // == path resolution

  const hostPathOf = (segments: Array<string>): string =>
    segments.length === 0
      ? (hostPrefix === "" ? "/" : hostPrefix)
      : `${hostPrefix}/${segments.join("/")}`

  /**
   * Resolves a WASI path relative to a directory fd, lexically: `.` and empty
   * segments drop, `..` pops, and — as in POSIX — `..` of the namespace root
   * is the root, so no path escapes the preopened slice.
   */
  const resolvePath = (dirFd: number, ptr: number, len: number): { nsPath: string; hostPath: string } => {
    const dir = dirOf(dirFd)
    const raw = decoder.decode(bytes(ptr, len))
    if (raw.length === 0) return fail(Errno.noent)
    const segments: Array<string> = raw.startsWith("/")
      ? []
      : dir.nsPath.split("/").filter((segment) => segment.length > 0)
    for (const segment of raw.split("/")) {
      if (segment === "" || segment === ".") continue
      if (segment === "..") {
        segments.pop()
        continue
      }
      segments.push(segment)
    }
    return { nsPath: `/${segments.join("/")}`, hostPath: hostPathOf(segments) }
  }

  // == stat plumbing

  const filetypeOf = (stats: SyncStatsLike | SyncDirentLike): number =>
    stats.isFile()
      ? FILETYPE.regularFile
      : stats.isDirectory()
      ? FILETYPE.directory
      : stats.isSymbolicLink()
      ? FILETYPE.symbolicLink
      : FILETYPE.unknown

  const writeFilestat = (
    ptr: number,
    filetype: number,
    stats: {
      readonly size: number
      readonly atimeMs: number
      readonly mtimeMs: number
      readonly ctimeMs: number
      readonly ino?: number
    }
  ): void => {
    const v = view()
    const at = ptr >>> 0
    v.setBigUint64(at, 0n, true) // dev
    v.setBigUint64(at + 8, BigInt(Math.trunc(stats.ino ?? 0)), true)
    v.setBigUint64(at + 16, BigInt(filetype), true) // u8 filetype + 7 pad bytes
    v.setBigUint64(at + 24, 1n, true) // nlink
    v.setBigUint64(at + 32, BigInt(stats.size), true)
    v.setBigUint64(at + 40, nsOfMs(stats.atimeMs), true)
    v.setBigUint64(at + 48, nsOfMs(stats.mtimeMs), true)
    v.setBigUint64(at + 56, nsOfMs(stats.ctimeMs), true)
  }

  const statOrUndefined = (path: string): SyncStatsLike | undefined => {
    try {
      return fs.statSync(path)
    } catch (cause) {
      if (codeOf(cause) === "ENOENT") return undefined
      throw cause
    }
  }

  const isSymlink = (path: string): boolean => {
    try {
      return fs.lstatSync(path).isSymbolicLink()
    } catch (cause) {
      if (codeOf(cause) === "ENOENT") return false
      throw cause
    }
  }

  /**
   * `fst_flags` decoded: an explicit nanosecond stamp, "now", or — when a side
   * is unset — the side's current value, read (through `statsOf`, so the fd
   * and path flavours each read their own addressee) before the write.
   */
  const resolveTimes = (
    statsOf: () => SyncStatsLike,
    atim: bigint,
    mtim: bigint,
    flags: number
  ): { readonly atimeSec: number; readonly mtimeSec: number } => {
    if ((flags & (FSTFLAGS.atim | FSTFLAGS.atimNow)) === (FSTFLAGS.atim | FSTFLAGS.atimNow)) fail(Errno.inval)
    if ((flags & (FSTFLAGS.mtim | FSTFLAGS.mtimNow)) === (FSTFLAGS.mtim | FSTFLAGS.mtimNow)) fail(Errno.inval)
    const stats = statsOf()
    // Deliberately ambient `Date.now`, not Effect's `Clock`: this is the
    // guest's own `clock_realtime`, read inside a synchronous WASI import
    // callback that the wasm module calls directly. There is no Effect fiber
    // on this stack to read a service from, and a guest whose wall clock came
    // from a swapped test clock would be lied to about the world it runs in.
    const nowSec = Date.now() / 1e3
    const atimeSec = (flags & FSTFLAGS.atim) !== 0
      ? Number(atim) / 1e9
      : (flags & FSTFLAGS.atimNow) !== 0
      ? nowSec
      : stats.atimeMs / 1e3
    const mtimeSec = (flags & FSTFLAGS.mtim) !== 0
      ? Number(mtim) / 1e9
      : (flags & FSTFLAGS.mtimNow) !== 0
      ? nowSec
      : stats.mtimeMs / 1e3
    return { atimeSec, mtimeSec }
  }

  // == iovecs

  const iovecs = (ptr: number, count: number): Array<{ readonly ptr: number; readonly len: number }> => {
    const v = view()
    const base = ptr >>> 0
    const out: Array<{ readonly ptr: number; readonly len: number }> = []
    for (let i = 0; i < (count >>> 0); i++) {
      out.push({ ptr: v.getUint32(base + i * 8, true), len: v.getUint32(base + i * 8 + 4, true) })
    }
    return out
  }

  // == syscalls

  const argsGet = (_argvPtr: number, _argvBufPtr: number): number => Errno.success

  const argsSizesGet = (argcPtr: number, argvBufSizePtr: number): number => {
    const v = view()
    v.setUint32(argcPtr >>> 0, 0, true)
    v.setUint32(argvBufSizePtr >>> 0, 0, true)
    return Errno.success
  }

  const clockResGet = (id: number, retPtr: number): number => {
    const resolution = id === 0 ? 1_000_000n : id === 1 || id === 2 || id === 3 ? 1_000n : fail(Errno.inval)
    view().setBigUint64(retPtr >>> 0, resolution, true)
    return Errno.success
  }

  const clockTimeGet = (id: number, _precision: bigint, retPtr: number): number => {
    // Same exemption as `resolveTimes` above: `clock_time_get` IS the WASI
    // clock shim, called synchronously by the guest, so it reads the host
    // clock directly rather than routing through Effect's `Clock`.
    const now = id === 0
      ? BigInt(Date.now()) * 1_000_000n
      : id === 1 || id === 2 || id === 3
      ? nsOfMs(performance.now())
      : fail(Errno.inval)
    view().setBigUint64(retPtr >>> 0, now, true)
    return Errno.success
  }

  const environGet = (_environPtr: number, _environBufPtr: number): number => Errno.success

  const environSizesGet = (countPtr: number, bufSizePtr: number): number => {
    const v = view()
    v.setUint32(countPtr >>> 0, 0, true)
    v.setUint32(bufSizePtr >>> 0, 0, true)
    return Errno.success
  }

  const fdAdvise = (fd: number, _offset: bigint, _len: bigint, _advice: number): number => {
    entryOf(fd)
    return Errno.success
  }

  const fdAllocate = (fd: number, _offset: bigint, _len: bigint): number => {
    fileOf(fd)
    return Errno.notsup
  }

  const fdClose = (fd: number): number => {
    const entry = entryOf(fd)
    if (entry.kind === "file") fs.closeSync(entry.osFd)
    fds.delete(fd >>> 0)
    return Errno.success
  }

  const fdDatasync = (fd: number): number => {
    entryOf(fd)
    return Errno.success
  }

  const fdFdstatGet = (fd: number, retPtr: number): number => {
    const entry = entryOf(fd)
    const filetype = entry.kind === "stdio"
      ? FILETYPE.characterDevice
      : entry.kind === "dir"
      ? FILETYPE.directory
      : FILETYPE.regularFile
    const flags = entry.kind === "file" && entry.append ? FDFLAGS.append : 0
    const v = view()
    const at = retPtr >>> 0
    v.setUint8(at, filetype)
    v.setUint8(at + 1, 0)
    v.setUint16(at + 2, flags, true)
    v.setUint32(at + 4, 0, true)
    v.setBigUint64(at + 8, ALL_RIGHTS, true)
    v.setBigUint64(at + 16, ALL_RIGHTS, true)
    return Errno.success
  }

  const fdFdstatSetFlags = (fd: number, flags: number): number => {
    const entry = entryOf(fd)
    if (entry.kind === "file") entry.append = (flags & FDFLAGS.append) !== 0
    return Errno.success
  }

  const fdFdstatSetRights = (fd: number, _base: bigint, _inheriting: bigint): number => {
    entryOf(fd)
    return Errno.success
  }

  const fdFilestatGet = (fd: number, retPtr: number): number => {
    const entry = entryOf(fd)
    if (entry.kind === "stdio") {
      writeFilestat(retPtr, FILETYPE.characterDevice, zeroStats)
      return Errno.success
    }
    const stats = entry.kind === "file" ? fs.fstatSync(entry.osFd) : fs.statSync(entry.hostPath)
    writeFilestat(retPtr, filetypeOf(stats), stats)
    return Errno.success
  }

  // The fd-addressed mutations go through the open os fd, never a path
  // remembered at open time: after a `path_rename` (jj's tempfile persist:
  // open → rename → mutate) the remembered path would name a different — or
  // freshly created, unrelated — file.
  const fdFilestatSetSize = (fd: number, size: bigint): number => {
    const entry = fileOf(fd)
    fs.ftruncateSync(entry.osFd, Number(size))
    return Errno.success
  }

  const fdFilestatSetTimes = (fd: number, atim: bigint, mtim: bigint, flags: number): number => {
    const entry = entryOf(fd)
    if (entry.kind === "stdio") return fail(Errno.badf)
    if (entry.kind === "file") {
      const times = resolveTimes(() => fs.fstatSync(entry.osFd), atim, mtim, flags)
      fs.futimesSync(entry.osFd, times.atimeSec, times.mtimeSec)
      return Errno.success
    }
    const times = resolveTimes(() => fs.statSync(entry.hostPath), atim, mtim, flags)
    fs.utimesSync(entry.hostPath, times.atimeSec, times.mtimeSec)
    return Errno.success
  }

  const fdPread = (fd: number, iovsPtr: number, iovsLen: number, offset: bigint, nreadPtr: number): number => {
    const entry = fileOf(fd)
    let position = offset
    let total = 0
    for (const iov of iovecs(iovsPtr, iovsLen)) {
      if (iov.len === 0) continue
      const n = fs.readSync(entry.osFd, bytes(iov.ptr, iov.len), 0, iov.len, Number(position))
      position += BigInt(n)
      total += n
      if (n < iov.len) break
    }
    view().setUint32(nreadPtr >>> 0, total, true)
    return Errno.success
  }

  const fdPrestatGet = (fd: number, retPtr: number): number => {
    const entry = entryOf(fd)
    if (entry.kind !== "dir" || entry.preopen === undefined) return fail(Errno.badf)
    const v = view()
    v.setUint32(retPtr >>> 0, 0, true) // tag: preopened directory, plus 3 pad bytes
    v.setUint32((retPtr >>> 0) + 4, encoder.encode(entry.preopen).length, true)
    return Errno.success
  }

  const fdPrestatDirName = (fd: number, ptr: number, len: number): number => {
    const entry = entryOf(fd)
    if (entry.kind !== "dir" || entry.preopen === undefined) return fail(Errno.badf)
    const name = encoder.encode(entry.preopen)
    if ((len >>> 0) < name.length) return fail(Errno.nametoolong)
    bytes(ptr, name.length).set(name)
    return Errno.success
  }

  const fdPwrite = (fd: number, iovsPtr: number, iovsLen: number, offset: bigint, nwrittenPtr: number): number => {
    const entry = fileOf(fd)
    let position = offset
    let total = 0
    for (const iov of iovecs(iovsPtr, iovsLen)) {
      if (iov.len === 0) continue
      const n = fs.writeSync(entry.osFd, bytes(iov.ptr, iov.len), 0, iov.len, Number(position))
      position += BigInt(n)
      total += n
      if (n < iov.len) break
    }
    view().setUint32(nwrittenPtr >>> 0, total, true)
    return Errno.success
  }

  const fdRead = (fd: number, iovsPtr: number, iovsLen: number, nreadPtr: number): number => {
    const entry = entryOf(fd)
    if (entry.kind === "stdio") {
      if (!entry.input) return fail(Errno.badf)
      view().setUint32(nreadPtr >>> 0, 0, true) // stdin is empty: immediate EOF
      return Errno.success
    }
    if (entry.kind === "dir") return fail(Errno.isdir)
    let total = 0
    for (const iov of iovecs(iovsPtr, iovsLen)) {
      if (iov.len === 0) continue
      const n = fs.readSync(entry.osFd, bytes(iov.ptr, iov.len), 0, iov.len, Number(entry.offset))
      entry.offset += BigInt(n)
      total += n
      if (n < iov.len) break
    }
    view().setUint32(nreadPtr >>> 0, total, true)
    return Errno.success
  }

  const fdReaddir = (fd: number, bufPtr: number, bufLen: number, cookie: bigint, retPtr: number): number => {
    const dir = dirOf(fd)
    const entries = fs.readdirSync(dir.hostPath, { withFileTypes: true })
    const len = bufLen >>> 0
    const buf = bytes(bufPtr, len)
    const start = Number(cookie)
    let used = 0
    for (const [index, dirent] of entries.entries()) {
      if (index < start) continue
      if (used >= len) break
      const name = encoder.encode(dirent.name)
      const record = new Uint8Array(24 + name.length)
      const rv = new DataView(record.buffer)
      rv.setBigUint64(0, BigInt(index + 1), true) // d_next: the cookie that resumes after this entry
      rv.setBigUint64(8, 0n, true) // d_ino
      rv.setUint32(16, name.length, true)
      rv.setUint32(20, filetypeOf(dirent), true) // u8 d_type + 3 pad bytes
      record.set(name, 24)
      const n = Math.min(record.length, len - used) // the spec truncates the final entry to fit
      buf.set(record.subarray(0, n), used)
      used += n
    }
    view().setUint32(retPtr >>> 0, used, true)
    return Errno.success
  }

  const fdRenumber = (from: number, to: number): number => {
    const entry = entryOf(from)
    if ((from >>> 0) === (to >>> 0)) return Errno.success
    const previous = fds.get(to >>> 0)
    if (previous !== undefined && previous.kind === "file") fs.closeSync(previous.osFd)
    fds.set(to >>> 0, entry)
    fds.delete(from >>> 0)
    // The allocator must never revisit the target number: a later path_open
    // reusing it would silently overwrite the live renumbered entry.
    if ((to >>> 0) >= nextFd) nextFd = (to >>> 0) + 1
    return Errno.success
  }

  const fdSeek = (fd: number, offset: bigint, whence: number, retPtr: number): number => {
    const entry = fileOf(fd)
    const target = whence === 0
      ? offset
      : whence === 1
      ? entry.offset + offset
      : whence === 2
      ? BigInt(fs.fstatSync(entry.osFd).size) + offset
      : fail(Errno.inval)
    if (target < 0n) return fail(Errno.inval)
    entry.offset = target
    view().setBigUint64(retPtr >>> 0, target, true)
    return Errno.success
  }

  const fdSync = (fd: number): number => {
    entryOf(fd)
    return Errno.success
  }

  const fdTell = (fd: number, retPtr: number): number => {
    const entry = fileOf(fd)
    view().setBigUint64(retPtr >>> 0, entry.offset, true)
    return Errno.success
  }

  const fdWrite = (fd: number, iovsPtr: number, iovsLen: number, nwrittenPtr: number): number => {
    const entry = entryOf(fd)
    if (entry.kind === "stdio") {
      if (entry.input) return fail(Errno.badf)
      const list = iovecs(iovsPtr, iovsLen)
      const total = list.reduce((sum, iov) => sum + iov.len, 0)
      const joined = new Uint8Array(total)
      let at = 0
      for (const iov of list) {
        joined.set(bytes(iov.ptr, iov.len), at)
        at += iov.len
      }
      if (entry.sink !== undefined) entry.sink(decoder.decode(joined))
      view().setUint32(nwrittenPtr >>> 0, total, true)
      return Errno.success
    }
    if (entry.kind === "dir") return fail(Errno.badf)
    let total = 0
    for (const iov of iovecs(iovsPtr, iovsLen)) {
      if (iov.len === 0) continue
      // Append targets the current end of file explicitly, so the semantics do
      // not depend on the backing fd carrying an OS-level O_APPEND — an fd can
      // acquire the flag later through fd_fdstat_set_flags.
      const position = entry.append ? fs.fstatSync(entry.osFd).size : Number(entry.offset)
      const n = fs.writeSync(entry.osFd, bytes(iov.ptr, iov.len), 0, iov.len, position)
      entry.offset = entry.append ? BigInt(position + n) : entry.offset + BigInt(n)
      total += n
      if (n < iov.len) break
    }
    view().setUint32(nwrittenPtr >>> 0, total, true)
    return Errno.success
  }

  const pathCreateDirectory = (fd: number, ptr: number, len: number): number => {
    const target = resolvePath(fd, ptr, len)
    fs.mkdirSync(target.hostPath)
    return Errno.success
  }

  const pathFilestatGet = (fd: number, lookupflags: number, ptr: number, len: number, retPtr: number): number => {
    const target = resolvePath(fd, ptr, len)
    const stats = (lookupflags & LOOKUPFLAGS.symlinkFollow) !== 0
      ? fs.statSync(target.hostPath)
      : fs.lstatSync(target.hostPath)
    writeFilestat(retPtr, filetypeOf(stats), stats)
    return Errno.success
  }

  const pathFilestatSetTimes = (
    fd: number,
    _lookupflags: number,
    ptr: number,
    len: number,
    atim: bigint,
    mtim: bigint,
    fstflags: number
  ): number => {
    const target = resolvePath(fd, ptr, len)
    const times = resolveTimes(() => fs.statSync(target.hostPath), atim, mtim, fstflags)
    fs.utimesSync(target.hostPath, times.atimeSec, times.mtimeSec)
    return Errno.success
  }

  const pathLink = (
    _oldFd: number,
    _oldFlags: number,
    _oldPtr: number,
    _oldLen: number,
    _newFd: number,
    _newPtr: number,
    _newLen: number
  ): number => Errno.notsup

  /**
   * Creates through a `"wx"`-family (exclusive) open, with the POSIX
   * dangling-symlink refinement: `O_CREAT` *without* `O_EXCL` on a path whose
   * follow-stat reported "missing" can still hit EEXIST when the path is a
   * dangling symlink — open(2) then creates the link's **target** and
   * succeeds, while `O_CREAT|O_EXCL` stays EEXIST on any symlink. The lstat
   * probe runs only inside the EEXIST fallback, so the common create pays no
   * extra backend call.
   */
  const openCreate = (path: string, flags: string, excl: boolean): number => {
    try {
      return fs.openSync(path, flags)
    } catch (cause) {
      if (excl || codeOf(cause) !== "EEXIST" || !isSymlink(path)) throw cause
      return fs.openSync(resolveLinkTarget(path), flags)
    }
  }

  /**
   * WASI `oflags`/`fdflags`/rights composed onto Node **string** open flags.
   * The one combination string flags cannot express directly — `O_CREAT`
   * without `O_TRUNC` on a missing file — opens `"wx"`-family instead, which
   * is equivalent because the file does not exist; and `O_CREAT` with
   * read-only rights creates via `"wx"` then reopens `"r"`.
   */
  const openFile = (
    path: string,
    o: {
      readonly existing: boolean
      readonly creat: boolean
      readonly excl: boolean
      readonly trunc: boolean
      readonly read: boolean
      readonly write: boolean
      readonly append: boolean
    }
  ): number => {
    if (!o.write) {
      if (o.creat && !o.existing) fs.closeSync(openCreate(path, "wx", o.excl))
      return fs.openSync(path, "r")
    }
    if (o.append) return fs.openSync(path, o.read ? "a+" : "a")
    if (o.creat) {
      if (o.trunc) return fs.openSync(path, o.excl ? (o.read ? "wx+" : "wx") : o.read ? "w+" : "w")
      if (!o.existing) return openCreate(path, o.read ? "wx+" : "wx", o.excl)
      return fs.openSync(path, "r+")
    }
    const osFd = fs.openSync(path, "r+")
    if (o.trunc) fs.ftruncateSync(osFd, 0)
    return osFd
  }

  /**
   * The final non-symlink path of a symlink chain, each target resolved
   * against its link's own directory (absolute targets taken as-is) — the
   * resolution the backend itself applies when following the link. Used only
   * for the create-through-a-dangling-link case, where the backend cannot be
   * asked to follow because nothing exists at the end yet.
   */
  const resolveLinkTarget = (hostPath: string): string => {
    let current = hostPath
    for (let depth = 0; depth < 40; depth++) {
      if (!isSymlink(current)) return current
      const link = fs.readlinkSync(current)
      if (link.startsWith("/")) {
        current = link
      } else {
        const at = current.lastIndexOf("/")
        current = `${at <= 0 ? "" : current.slice(0, at)}/${link}`
      }
    }
    return fail(Errno.loop)
  }

  const pathOpen = (
    dirFd: number,
    dirflags: number,
    pathPtr: number,
    pathLen: number,
    oflags: number,
    rightsBase: bigint,
    _rightsInheriting: bigint,
    fdflags: number,
    retPtr: number
  ): number => {
    const target = resolvePath(dirFd, pathPtr, pathLen)
    const follow = (dirflags & LOOKUPFLAGS.symlinkFollow) !== 0
    if (!follow && isSymlink(target.hostPath)) return fail(Errno.loop)
    const creat = (oflags & OFLAGS.creat) !== 0
    const excl = (oflags & OFLAGS.excl) !== 0
    const trunc = (oflags & OFLAGS.trunc) !== 0
    const wantDir = (oflags & OFLAGS.directory) !== 0
    const read = (rightsBase & RIGHTS.fdRead) !== 0n
    const write = (rightsBase & RIGHTS.fdWrite) !== 0n
    const append = (fdflags & FDFLAGS.append) !== 0
    const existing = statOrUndefined(target.hostPath)

    if (creat && excl && existing !== undefined) return fail(Errno.exist)
    if (existing !== undefined && existing.isDirectory()) {
      if (write || trunc) return fail(Errno.isdir)
      view().setUint32(retPtr >>> 0, newFd({ kind: "dir", nsPath: target.nsPath, hostPath: target.hostPath }), true)
      return Errno.success
    }
    if (wantDir) return fail(existing === undefined ? Errno.noent : Errno.notdir)
    if (existing === undefined && !creat) return fail(Errno.noent)
    if (trunc && !write) return fail(Errno.inval)

    const osFd = openFile(target.hostPath, {
      existing: existing !== undefined,
      creat,
      excl,
      trunc,
      read,
      write,
      append
    })
    view().setUint32(retPtr >>> 0, newFd({ kind: "file", osFd, offset: 0n, append }), true)
    return Errno.success
  }

  const pathReadlink = (
    fd: number,
    ptr: number,
    len: number,
    bufPtr: number,
    bufLen: number,
    retPtr: number
  ): number => {
    const target = resolvePath(fd, ptr, len)
    const linkTarget = encoder.encode(fs.readlinkSync(target.hostPath))
    const n = Math.min(linkTarget.length, bufLen >>> 0)
    bytes(bufPtr, n).set(linkTarget.subarray(0, n))
    view().setUint32(retPtr >>> 0, n, true)
    return Errno.success
  }

  const pathRemoveDirectory = (fd: number, ptr: number, len: number): number => {
    const target = resolvePath(fd, ptr, len)
    fs.rmdirSync(target.hostPath)
    return Errno.success
  }

  const pathRename = (
    fd: number,
    oldPtr: number,
    oldLen: number,
    newFd: number,
    newPtr: number,
    newLen: number
  ): number => {
    const from = resolvePath(fd, oldPtr, oldLen)
    const to = resolvePath(newFd, newPtr, newLen)
    fs.renameSync(from.hostPath, to.hostPath)
    return Errno.success
  }

  const pathSymlink = (oldPtr: number, oldLen: number, fd: number, newPtr: number, newLen: number): number => {
    const linkTarget = decoder.decode(bytes(oldPtr, oldLen))
    if (linkTarget.length === 0) return fail(Errno.noent)
    const at = resolvePath(fd, newPtr, newLen)
    fs.symlinkSync(linkTarget, at.hostPath)
    return Errno.success
  }

  const pathUnlinkFile = (fd: number, ptr: number, len: number): number => {
    const target = resolvePath(fd, ptr, len)
    fs.unlinkSync(target.hostPath)
    return Errno.success
  }

  const pollOneoff = (inPtr: number, outPtr: number, nsubscriptions: number, retPtr: number): number => {
    const count = nsubscriptions >>> 0
    if (count === 0) return fail(Errno.inval)
    const v = view()
    for (let i = 0; i < count; i++) {
      const sub = (inPtr >>> 0) + i * 48
      const event = (outPtr >>> 0) + i * 32
      v.setBigUint64(event, v.getBigUint64(sub, true), true) // userdata
      v.setUint16(event + 8, Errno.success, true)
      v.setUint32(event + 10, v.getUint8(sub + 8), true) // u8 event type + pad
      v.setBigUint64(event + 16, 0n, true)
      v.setBigUint64(event + 24, 0n, true)
    }
    v.setUint32(retPtr >>> 0, count, true)
    return Errno.success
  }

  const procExit = (code: number): number => {
    throw new WasiExitError(code >>> 0)
  }

  const procRaise = (_signal: number): number => Errno.notsup

  const randomGet = (ptr: number, len: number): number => {
    const target = bytes(ptr, len)
    for (let at = 0; at < target.length; at += 65536) {
      crypto.getRandomValues(target.subarray(at, Math.min(at + 65536, target.length)))
    }
    return Errno.success
  }

  const schedYield = (): number => Errno.success

  const sockAccept = (_fd: number, _flags: number, _retPtr: number): number => Errno.notsup
  const sockRecv = (
    _fd: number,
    _iovsPtr: number,
    _iovsLen: number,
    _riFlags: number,
    _nreadPtr: number,
    _roFlagsPtr: number
  ): number => Errno.notsup
  const sockSend = (_fd: number, _iovsPtr: number, _iovsLen: number, _siFlags: number, _nwrittenPtr: number): number =>
    Errno.notsup
  const sockShutdown = (_fd: number, _how: number): number => Errno.notsup

  // == the import namespace

  /** Backend and internal errors surfaced as errno; real bugs rethrown. */
  const errnoOf = (cause: unknown): number => {
    if (cause instanceof ErrnoError) return cause.errno
    if (cause instanceof RangeError) return Errno.fault // out-of-bounds wasm memory access
    const code = codeOf(cause)
    if (code !== undefined) return errnoByCode[code] ?? Errno.io
    throw cause
  }

  const syscall = <Args extends Array<number | bigint>>(body: (...args: Args) => number) => (...args: Args): number => {
    try {
      return body(...args)
    } catch (cause) {
      return errnoOf(cause)
    }
  }

  const imports = {
    args_get: syscall(argsGet),
    args_sizes_get: syscall(argsSizesGet),
    clock_res_get: syscall(clockResGet),
    clock_time_get: syscall(clockTimeGet),
    environ_get: syscall(environGet),
    environ_sizes_get: syscall(environSizesGet),
    fd_advise: syscall(fdAdvise),
    fd_allocate: syscall(fdAllocate),
    fd_close: syscall(fdClose),
    fd_datasync: syscall(fdDatasync),
    fd_fdstat_get: syscall(fdFdstatGet),
    fd_fdstat_set_flags: syscall(fdFdstatSetFlags),
    fd_fdstat_set_rights: syscall(fdFdstatSetRights),
    fd_filestat_get: syscall(fdFilestatGet),
    fd_filestat_set_size: syscall(fdFilestatSetSize),
    fd_filestat_set_times: syscall(fdFilestatSetTimes),
    fd_pread: syscall(fdPread),
    fd_prestat_get: syscall(fdPrestatGet),
    fd_prestat_dir_name: syscall(fdPrestatDirName),
    fd_pwrite: syscall(fdPwrite),
    fd_read: syscall(fdRead),
    fd_readdir: syscall(fdReaddir),
    fd_renumber: syscall(fdRenumber),
    fd_seek: syscall(fdSeek),
    fd_sync: syscall(fdSync),
    fd_tell: syscall(fdTell),
    fd_write: syscall(fdWrite),
    path_create_directory: syscall(pathCreateDirectory),
    path_filestat_get: syscall(pathFilestatGet),
    path_filestat_set_times: syscall(pathFilestatSetTimes),
    path_link: syscall(pathLink),
    path_open: syscall(pathOpen),
    path_readlink: syscall(pathReadlink),
    path_remove_directory: syscall(pathRemoveDirectory),
    path_rename: syscall(pathRename),
    path_symlink: syscall(pathSymlink),
    path_unlink_file: syscall(pathUnlinkFile),
    poll_oneoff: syscall(pollOneoff),
    proc_exit: syscall(procExit),
    proc_raise: syscall(procRaise),
    random_get: syscall(randomGet),
    sched_yield: syscall(schedYield),
    sock_accept: syscall(sockAccept),
    sock_recv: syscall(sockRecv),
    sock_send: syscall(sockSend),
    sock_shutdown: syscall(sockShutdown)
  }

  return {
    imports,
    initialize: (exported) => {
      memory = exported
    }
  }
}
