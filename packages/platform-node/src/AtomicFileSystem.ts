/**
 * Descriptor-relative filesystem operations for the capability kernel.
 *
 * Node does not expose `openat(2)` / `renameat(2)`. This adapter delegates
 * each operation to a small POSIX helper. The helper opens the filesystem
 * root once, walks every component with `O_NOFOLLOW`, and performs the final
 * syscall relative to a pinned parent descriptor. Missing Python/POSIX
 * primitives are reported as a typed, fail-closed platform error.
 *
 * **Host prerequisite.** A POSIX host with CPython 3 installed at
 * {@link defaultExecutable} (`/usr/bin/python3`), whose `os` module supports
 * `O_NOFOLLOW`, `O_DIRECTORY`, and `dir_fd` for `open`, `mkdir`, `readlink`,
 * `rename`, `rmdir`, `stat`, and `unlink`. A host that installs its
 * interpreter somewhere else configures the absolute path through
 * {@link layerWith}. **Windows is not supported**: it has none of these
 * primitives, and `/usr/bin/python3` does not exist there, so every operation
 * fails closed rather than falling back to a path-based call.
 *
 * The interpreter is addressed by absolute path and never looked up through
 * `PATH`, and the helper runs isolated from the ambient environment — an inert
 * working directory, an empty environment, no module search path entry for the
 * cwd or `PYTHONPATH`, and UTF-8 pinned for the request, the response, and the
 * filesystem encoding — so neither the workspace it confines nor the
 * environment it was started under can change what it executes or which path
 * it addresses.
 *
 * Both directions of the helper protocol are length-framed and bounded by
 * {@link defaultLimits}, so neither a large file nor a malfunctioning helper
 * can make the host allocate without limit.
 *
 * @since 0.1.0
 */
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import { Effect, FileSystem, Layer, Option, PlatformError } from "effect"
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { accessSync, constants, realpathSync, statSync } from "node:fs"
import { isAbsolute, relative } from "node:path"

const helper = String.raw`
import base64, errno, json, os, re, stat, sys

PROTOCOL = "flows-atomic/1"
# The header is read one byte at a time, so it is capped before anything is
# allocated for it. The hard cap bounds what any declared limit may claim,
# whatever the host asked for.
HEADER_CAP = 256
HARD_CAP = 256 * 1024 * 1024
MESSAGE_CAP = 4096
CHUNK = 65536
ENTRY_CAP = 100000

required_dir_fd = (os.open, os.mkdir, os.readlink, os.rename, os.rmdir, os.stat, os.unlink)
if not hasattr(os, "O_NOFOLLOW") or not hasattr(os, "O_DIRECTORY"):
    raise OSError(errno.ENOTSUP, "O_NOFOLLOW/O_DIRECTORY unavailable")
if any(function not in os.supports_dir_fd for function in required_dir_fd):
    raise OSError(errno.ENOTSUP, "descriptor-relative POSIX operations unavailable")

NOFOLLOW = os.O_NOFOLLOW
DIRECTORY = os.O_DIRECTORY
EPROTO = getattr(errno, "EPROTO", errno.EINVAL)

# Effect's FileSystem.OpenFlag translated to POSIX open flags. O_TRUNC is
# deliberately absent: truncating is a mutation, so it has to happen on the
# already-opened descriptor after the hard-link and file-kind checks, never as
# a side effect of open() itself. A read-only flag stays read-only, so writing
# through it fails with EBADF exactly as it does on Node.
OPEN_FLAGS = {
    "r": os.O_RDONLY,
    "r+": os.O_RDWR,
    "w": os.O_WRONLY | os.O_CREAT,
    "wx": os.O_WRONLY | os.O_CREAT | os.O_EXCL,
    "w+": os.O_RDWR | os.O_CREAT,
    "wx+": os.O_RDWR | os.O_CREAT | os.O_EXCL,
    "a": os.O_WRONLY | os.O_CREAT | os.O_APPEND,
    "ax": os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_APPEND,
    "a+": os.O_RDWR | os.O_CREAT | os.O_APPEND,
    "ax+": os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_APPEND,
}
TRUNCATED_FLAGS = ("w", "w+")

class BadArgument(Exception):
    """Caller input rejected before any operation runs. Node rejects an unknown
    open flag the same way, and Effect reports it as BadArgument rather than as
    a system error."""

def file_type(mode):
    """Effect's FileSystem.File.Type. Reporting the precise kind is part of the
    contract: a caller that has to tell a FIFO from a socket cannot be handed
    one catch-all name, and every value here is one Effect declares."""
    if stat.S_ISREG(mode): return "File"
    if stat.S_ISDIR(mode): return "Directory"
    if stat.S_ISLNK(mode): return "SymbolicLink"
    if stat.S_ISFIFO(mode): return "FIFO"
    if stat.S_ISSOCK(mode): return "Socket"
    if stat.S_ISBLK(mode): return "BlockDevice"
    if stat.S_ISCHR(mode): return "CharacterDevice"
    return "Unknown"

def parts(path):
    if not os.path.isabs(path):
        raise OSError(errno.EINVAL, "atomic path must be absolute", path)
    return [part for part in path.split(os.sep) if part not in ("", ".")]

def parent(root, path, create=False, mode=0o777):
    values = parts(path)
    if not values:
        raise OSError(errno.EPERM, "refusing filesystem root", path)
    fd = os.dup(root)
    try:
        for name in values[:-1]:
            if name == "..":
                raise OSError(errno.EPERM, "parent traversal denied", path)
            try:
                nxt = os.open(name, os.O_RDONLY | DIRECTORY | NOFOLLOW, dir_fd=fd)
            except FileNotFoundError:
                if not create:
                    raise
                os.mkdir(name, mode, dir_fd=fd)
                nxt = os.open(name, os.O_RDONLY | DIRECTORY | NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = nxt
        return fd, values[-1]
    except BaseException:
        os.close(fd)
        raise

def entry_stat(root, path):
    """lstat of the final component, relative to the pinned parent descriptor.
    A metadata question must not OPEN the entry: opening a FIFO, a device, or a
    socket has side effects the caller never asked for, and for a socket it
    simply fails. The parent is still pinned, so the answer is about the entry
    the walk reached, not about a name re-resolved from the top."""
    directory, name = parent(root, path)
    try:
        return os.stat(name, dir_fd=directory, follow_symlinks=False)
    finally:
        os.close(directory)

def open_file(root, path, flags, mode=0o666):
    """The single final-open path, used only where the CONTENT of a regular
    file is read or written. The confinement contract is stated once: the open
    is relative to the pinned parent descriptor, O_NOFOLLOW refuses a symlink,
    O_NONBLOCK stops a planted FIFO from parking the helper forever in open(),
    and the descriptor is then required to be a regular file with one link
    before the caller can act on it. Requiring the kind on the DESCRIPTOR (not
    on a name that could be swapped afterwards) is what keeps a FIFO, a device,
    a socket, or a directory out of every content read and write."""
    directory, name = parent(root, path)
    try:
        fd = os.open(name, flags | NOFOLLOW | os.O_NONBLOCK, mode, dir_fd=directory)
    finally:
        os.close(directory)
    try:
        info = os.fstat(fd)
        if stat.S_ISDIR(info.st_mode):
            raise OSError(errno.EISDIR, "path is a directory", path)
        if not stat.S_ISREG(info.st_mode):
            raise OSError(errno.EPERM,
                          "only regular files carry content: refusing a " + file_type(info.st_mode),
                          path)
        if info.st_nlink > 1:
            raise OSError(errno.EPERM, "hard-linked files cannot be confined", path)
    except BaseException:
        # fstat itself can fail, and every refusal above owns the descriptor,
        # so the close belongs here rather than after a successful check.
        os.close(fd)
        raise
    return fd

def list_dir(root, path, recursive, budget):
    if not parts(path):
        fd = os.dup(root)
    else:
        directory, name = parent(root, path)
        try:
            fd = os.open(name, os.O_RDONLY | DIRECTORY | NOFOLLOW, dir_fd=directory)
        finally:
            os.close(directory)
    # Include the response envelope and the list delimiters up front. Each
    # retained name is then charged by its exact JSON encoding, not by its raw
    # filesystem bytes: quotes, backslashes, and control characters expand in
    # JSON and must not turn a nominally bounded listing into a much larger
    # allocation.
    total = [32]
    entries = [0]
    def walk(current, prefix=""):
        # Listing NAMES a directory entry; it never resolves one. A symlink is
        # reported by name and never descended into, so a listing cannot leave
        # the pinned root and cannot be made to by planting a link. Refusing
        # the whole listing instead would buy no confinement and would make
        # every recursive list and glob over a real workspace fail.
        result = []
        names = []
        # os.listdir materializes the whole directory before the loop can
        # enforce any bound. scandir is incremental, so a hostile wide
        # directory is refused after ENTRY_CAP names rather than allocated in
        # full; only the bounded batch is then sorted for deterministic output.
        with os.scandir(current) as iterator:
            for item in iterator:
                entry = item.name
                relative = os.path.join(prefix, entry) if prefix else entry
                entries[0] += 1
                if entries[0] > ENTRY_CAP:
                    raise OSError(errno.EFBIG, "directory listing has too many entries", path)
                # Charged before the name is retained, so a tree large enough
                # to exhaust the response budget is refused instead of
                # accumulated.
                total[0] += len(json.dumps(relative, ensure_ascii=False).encode("utf-8")) + 1
                if total[0] > budget:
                    raise OSError(errno.EFBIG, "directory listing exceeds the response limit", path)
                names.append((entry, relative))
        names.sort(key=lambda item: item[0])
        for entry, relative in names:
            info = os.stat(entry, dir_fd=current, follow_symlinks=False)
            result.append(relative)
            # The lstat above makes S_ISDIR false for a link to a directory,
            # so this descends only into real subdirectories.
            if recursive and stat.S_ISDIR(info.st_mode):
                child = os.open(entry, os.O_RDONLY | DIRECTORY | NOFOLLOW, dir_fd=current)
                try:
                    result.extend(walk(child, relative))
                finally:
                    os.close(child)
        return result
    try:
        return walk(fd)
    finally:
        os.close(fd)

def segment_regex(segment):
    out = []
    index = 0
    while index < len(segment):
        char = segment[index]
        if char == "*":
            out.append("[^/]*")
        elif char == "?":
            out.append("[^/]")
        elif char == "[":
            end = segment.find("]", index + 1)
            if end == -1:
                out.append(re.escape(char))
            else:
                body = segment[index + 1:end]
                out.append("[" + ("^" + body[1:] if body.startswith("!") else body) + "]")
                index = end
        else:
            out.append(re.escape(char))
        index += 1
    return "".join(out)

def glob_regex(pattern):
    # fnmatch is not a glob: its "*" crosses "/", so "*.txt" would match
    # "nested/text.txt" and "**/*.txt" would miss a top-level file. Translate
    # segment by segment instead, so "*" and "?" stay inside one segment and
    # "**" spans zero or more whole segments.
    segments = [segment for segment in pattern.split("/") if segment != ""]
    out = ""
    for index, segment in enumerate(segments):
        last = index == len(segments) - 1
        if segment == "**":
            out += "[^/]+(?:/[^/]+)*" if last else "(?:[^/]+/)*"
        else:
            out += segment_regex(segment) + ("" if last else "/")
    try:
        return re.compile("\\A" + out + "\\Z")
    except re.error as invalid:
        # A character class the translation cannot close ("[]]") is caller
        # input, not a host failure, so it is reported the way an unknown open
        # flag is rather than as an opaque interpreter crash.
        raise BadArgument("glob pattern is not translatable: " + str(invalid))

def remove_at(directory, name, recursive):
    info = os.stat(name, dir_fd=directory, follow_symlinks=False)
    if stat.S_ISLNK(info.st_mode):
        raise OSError(errno.ELOOP, "symbolic links are outside the atomic boundary", name)
    if not stat.S_ISDIR(info.st_mode):
        os.unlink(name, dir_fd=directory)
        return
    if not recursive:
        os.rmdir(name, dir_fd=directory)
        return
    child = os.open(name, os.O_RDONLY | DIRECTORY | NOFOLLOW, dir_fd=directory)
    try:
        for entry in os.listdir(child):
            remove_at(child, entry, True)
    finally:
        os.close(child)
    os.rmdir(name, dir_fd=directory)

def main(request, content_limit, response_limit):
    operation = request["operation"]
    options = request.get("options") or {}
    logical_root = request["logicalRoot"]
    def confined(path):
        relative = os.path.relpath(path, logical_root)
        if relative == ".." or relative.startswith(".." + os.sep):
            raise OSError(errno.EPERM, "path is outside the pinned root", path)
        # The root itself confines to os.sep, whose component list is empty.
        # Every operation below decides for itself what that means, and
        # parent() refuses it, which keeps the destructive ones refused.
        return os.sep if relative == "." else os.sep + relative
    root = os.open(request["boundaryRoot"], os.O_RDONLY | DIRECTORY | NOFOLLOW)
    try:
        if operation in ("readFile", "readFileString"):
            path = confined(request["path"])
            if not parts(path):
                raise OSError(errno.EISDIR, "the workspace root is a directory", request["path"])
            fd = open_file(root, path, os.O_RDONLY)
            try:
                chunks = []
                total = 0
                while True:
                    chunk = os.read(fd, CHUNK)
                    if not chunk: break
                    total += len(chunk)
                    # Charged per chunk, so a file larger than the contract is
                    # refused after one chunk of allocation rather than after
                    # the host has been asked to hold all of it.
                    if total > content_limit:
                        raise OSError(errno.EFBIG, "file exceeds the atomic read limit", request["path"])
                    chunks.append(chunk)
                data = b"".join(chunks)
            finally:
                os.close(fd)
            return {"base64": base64.b64encode(data).decode("ascii")}
        if operation == "exists":
            path = confined(request["path"])
            # The pinned root exists by construction: it is already open.
            if not parts(path):
                return True
            try:
                info = entry_stat(root, path)
            except FileNotFoundError:
                return False
            if stat.S_ISLNK(info.st_mode):
                raise OSError(errno.ELOOP, "symbolic links are outside the atomic boundary", request["path"])
            # A directory, a FIFO, a device, and a socket all EXIST; only
            # reading or writing their content is refused.
            return True
        if operation == "readLink":
            path = confined(request["path"])
            if not parts(path):
                raise OSError(errno.EINVAL, "the workspace root is not a symbolic link", request["path"])
            directory, name = parent(root, path)
            try: return os.readlink(name, dir_fd=directory)
            finally: os.close(directory)
        if operation == "realPath":
            confined_path = confined(request["path"])
            if parts(confined_path):
                info = entry_stat(root, confined_path)
                if stat.S_ISLNK(info.st_mode):
                    raise OSError(errno.ELOOP, "symbolic links are outside the atomic boundary", request["path"])
            relative = os.path.relpath(request["path"], logical_root)
            return os.path.normpath(os.path.join(request["boundaryRoot"], relative))
        if operation in ("writeFile", "writeFileString"):
            path = confined(request["path"])
            if not parts(path):
                raise OSError(errno.EISDIR, "the workspace root is a directory", request["path"])
            flag = options.get("flag", "w")
            if flag not in OPEN_FLAGS:
                raise BadArgument("unknown file open flag: " + str(flag))
            # Decoded and measured BEFORE the file is opened, so an over-limit
            # payload cannot truncate or partially overwrite the target.
            data = (base64.b64decode(request["data"], validate=True) if operation == "writeFile"
                    else request["data"].encode("utf-8"))
            if len(data) > content_limit:
                raise OSError(errno.EFBIG, "payload exceeds the atomic write limit", request["path"])
            # The open goes through open_file so the write path cannot drift from
            # the confinement contract the read path already enforces.
            fd = open_file(root, path, OPEN_FLAGS[flag], int(options.get("mode", 0o666)))
            try:
                # Truncation happens here rather than through O_TRUNC so that a
                # hard link, a FIFO, or a device is refused before the entry is
                # modified at all.
                if flag in TRUNCATED_FLAGS:
                    os.ftruncate(fd, 0)
                view = memoryview(data)
                while view:
                    written = os.write(fd, view)
                    # POSIX allows a zero-length write. Slicing by 0 would spin
                    # forever, so it is reported instead.
                    if written <= 0:
                        raise OSError(errno.EIO, "the host accepted no bytes", request["path"])
                    view = view[written:]
            finally:
                os.close(fd)
            return None
        if operation == "makeDirectory":
            path = confined(request["path"])
            recursive = bool(options.get("recursive"))
            mode = int(options.get("mode", 0o777))
            if not parts(path):
                # A recursive mkdir over an existing directory is a no-op, and
                # the pinned root is always an existing directory.
                if recursive: return None
                raise OSError(errno.EEXIST, "the workspace root already exists", request["path"])
            directory, name = parent(root, path, recursive, mode)
            try:
                try:
                    os.mkdir(name, mode, dir_fd=directory)
                except FileExistsError as conflict:
                    # The recursive option only excuses an existing DIRECTORY.
                    # The question is asked with an lstat relative to the
                    # pinned parent rather than by opening the entry, so a
                    # planted FIFO or device is answered without being opened:
                    # a symlink is not a directory even when it points at one,
                    # and a regular file keeps the EEXIST that Node reports.
                    if not recursive: raise
                    existing = os.stat(name, dir_fd=directory, follow_symlinks=False)
                    if not stat.S_ISDIR(existing.st_mode):
                        raise OSError(errno.ELOOP if stat.S_ISLNK(existing.st_mode) else errno.EEXIST,
                                      "existing entry is a " + file_type(existing.st_mode),
                                      request["path"])
            finally: os.close(directory)
            return None
        if operation == "readDirectory":
            return list_dir(root, confined(request["path"]), bool(options.get("recursive")), response_limit)
        if operation == "remove":
            directory, name = parent(root, confined(request["path"]))
            try: remove_at(directory, name, bool(options.get("recursive")))
            except FileNotFoundError:
                if not options.get("force"): raise
            finally: os.close(directory)
            return None
        if operation == "rename":
            old_dir, old_name = parent(root, confined(request["from"]))
            # Resolving the destination can fail on its own — a missing parent,
            # or the pinned root named as the destination — and the source
            # descriptor is already open by then, so it is closed explicitly
            # rather than left to interpreter teardown.
            try:
                new_dir, new_name = parent(root, confined(request["to"]))
            except BaseException:
                os.close(old_dir)
                raise
            try:
                info = os.stat(old_name, dir_fd=old_dir, follow_symlinks=False)
                if stat.S_ISLNK(info.st_mode): raise OSError(errno.ELOOP, "symbolic link rename denied")
                try:
                    destination = os.stat(new_name, dir_fd=new_dir, follow_symlinks=False)
                    if stat.S_ISLNK(destination.st_mode): raise OSError(errno.ELOOP, "symbolic link rename denied")
                except FileNotFoundError:
                    pass
                os.rename(old_name, new_name, src_dir_fd=old_dir, dst_dir_fd=new_dir)
            finally:
                os.close(old_dir); os.close(new_dir)
            return None
        if operation == "stat":
            path = confined(request["path"])
            if not parts(path):
                info = os.fstat(root)
            else:
                info = entry_stat(root, path)
                if stat.S_ISLNK(info.st_mode):
                    raise OSError(errno.ELOOP, "symbolic links are outside the atomic boundary", request["path"])
                if stat.S_ISREG(info.st_mode) and info.st_nlink > 1:
                    raise OSError(errno.EPERM, "hard-linked files cannot be confined", request["path"])
            birthtime = getattr(info, "st_birthtime", None)
            return {"type": file_type(info.st_mode),
                    "mtime": info.st_mtime * 1000, "atime": info.st_atime * 1000,
                    "birthtime": None if birthtime is None else birthtime * 1000,
                    "dev": info.st_dev, "ino": info.st_ino, "mode": stat.S_IMODE(info.st_mode),
                    "nlink": info.st_nlink, "uid": info.st_uid, "gid": info.st_gid,
                    "rdev": info.st_rdev, "size": str(info.st_size),
                    "blksize": (None if getattr(info, "st_blksize", None) is None
                                  else str(info.st_blksize)),
                    "blocks": getattr(info, "st_blocks", None)}
        if operation == "glob":
            root_path = request["root"]
            relative_pattern = os.path.relpath(request["pattern"], root_path)
            # Translated before the tree is walked, so an untranslatable
            # pattern costs no listing at all.
            selected = glob_regex(relative_pattern)
            excluded = [glob_regex(pattern) for pattern in options.get("exclude", [])]
            names = list_dir(root, confined(root_path), True, response_limit)
            matches = []
            total = 32
            for name in names:
                if not selected.match(name) or any(pattern.match(name) for pattern in excluded):
                    continue
                match = os.path.join(root_path, name)
                total += len(json.dumps(match, ensure_ascii=False).encode("utf-8")) + 1
                if total > response_limit:
                    raise OSError(errno.EFBIG, "glob result exceeds the response limit", root_path)
                matches.append(match)
            return matches
        raise OSError(errno.ENOTSUP, "atomic operation is unsupported", operation)
    finally:
        os.close(root)

def read_header(stream):
    # One byte at a time against a cap, so an unframed stream cannot make the
    # helper buffer without bound before it has agreed on a length.
    header = b""
    while not header.endswith(b"\n"):
        if len(header) >= HEADER_CAP:
            raise OSError(EPROTO, "atomic request header is unframed")
        byte = stream.read(1)
        if not byte:
            raise OSError(EPROTO, "atomic request header is truncated")
        header += byte
    return header[:-1].decode("ascii")

def read_exact(stream, count):
    chunks = []
    remaining = count
    while remaining > 0:
        chunk = stream.read(min(remaining, CHUNK))
        if not chunk:
            raise OSError(EPROTO, "atomic request is truncated")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)

def respond(payload, limit):
    # Length-framed over the byte stream rather than through print(). The text
    # wrappers on sys.stdin and sys.stdout encode with whatever the ambient
    # locale says, so a host started under a legacy locale silently
    # mistranslated every non-ASCII path and every writeFileString payload --
    # addressing a different file, or writing mojibake, and reporting success
    # either way. Both directions are pinned to UTF-8 here, and -X utf8 on the
    # command line pins the filesystem encoding the same way. The frame is what
    # lets the host tell a complete response from a truncated one, from two.
    body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if len(body) > limit:
        body = json.dumps({"ok": False, "code": None, "badArgument": False,
                           "message": "atomic response exceeds the %d byte limit" % limit},
                          separators=(",", ":")).encode("utf-8")
    sys.stdout.buffer.write(("%s %d\n" % (PROTOCOL, len(body))).encode("ascii"))
    sys.stdout.buffer.write(body)
    sys.stdout.buffer.flush()

response_limit = 1 << 16
try:
    fields = read_header(sys.stdin.buffer).split(" ")
    if len(fields) != 5 or fields[0] != PROTOCOL:
        raise OSError(EPROTO, "atomic request is not framed")
    declared, request_limit, content_limit, declared_response = (int(field) for field in fields[1:])
    if not 0 < declared_response <= HARD_CAP or not 0 < request_limit <= HARD_CAP or not 0 < content_limit <= HARD_CAP:
        raise OSError(EPROTO, "atomic limits are out of range")
    response_limit = declared_response
    if not 0 <= declared <= request_limit:
        raise OSError(errno.EFBIG, "atomic request exceeds the request limit")
    payload = read_exact(sys.stdin.buffer, declared)
    if sys.stdin.buffer.read(1):
        raise OSError(EPROTO, "atomic request carried trailing bytes")
    respond({"ok": True, "value": main(json.loads(payload.decode("utf-8")), content_limit, response_limit)},
            response_limit)
except BaseException as error:
    number = getattr(error, "errno", None)
    respond({"ok": False,
             "code": errno.errorcode.get(number) if isinstance(number, int) else None,
             "badArgument": isinstance(error, BadArgument),
             "message": str(error)[:MESSAGE_CAP]}, response_limit)
`

/**
 * The POSIX helper program the adapter runs. Exported so the protocol guards
 * on the helper's own side can be driven with frames the adapter would never
 * send, which is the only way to observe them.
 *
 * @since 0.1.0
 * @category constants
 */
export const program: string = helper

/**
 * The absolute path the adapter runs the POSIX helper from. It is a fixed
 * absolute path and never a `PATH` lookup: `-I` isolates the interpreter only
 * *after* one has been chosen, so a `python3` planted in the working directory
 * or on an injected `PATH` would already have executed arbitrary code inside
 * the process that holds the pinned root descriptor.
 *
 * @since 0.1.0
 * @category constants
 */
export const defaultExecutable = "/usr/bin/python3"

/**
 * Byte ceilings for the helper protocol. Every one of them is a contract, not
 * a tuning knob: without them a large file, a large directory tree, or a
 * malfunctioning helper makes the host allocate until it dies.
 *
 * - `content` bounds the bytes a single `readFile`/`writeFile` may carry.
 * - `request` bounds the framed request; an over-limit request is refused
 *   before an interpreter is even started.
 * - `response` bounds the framed response, and is what a directory listing is
 *   charged against as it is built.
 * - `stderr` bounds the diagnostic text retained from a failing helper.
 *
 * @since 0.1.0
 * @category models
 */
export interface Limits {
  readonly content: number
  readonly request: number
  readonly response: number
  readonly stderr: number
}

/**
 * 16 MiB of file content, 24 MiB of framed request and response (base64
 * expands 16 MiB to 22369624 bytes, which has to fit), and 64 KiB of retained
 * helper diagnostics.
 *
 * @since 0.1.0
 * @category constants
 */
export const defaultLimits: Limits = {
  content: 16 * 1024 * 1024,
  request: 24 * 1024 * 1024,
  response: 24 * 1024 * 1024,
  stderr: 64 * 1024
}

/**
 * The deliberate seam for a POSIX host that installs CPython somewhere other
 * than {@link defaultExecutable}, or that needs different byte ceilings. It is
 * configuration, never discovery: the value is validated as an absolute,
 * executable regular file outside the confined workspace on every request.
 *
 * @since 0.1.0
 * @category models
 */
export interface Options {
  readonly executable?: string | undefined
  readonly limits?: Partial<Limits> | undefined
}

interface HelperResult {
  readonly ok: boolean
  readonly value?: unknown
  readonly code?: string | null
  readonly badArgument?: boolean
  readonly message?: string
}

const moduleName = "AtomicFileSystem"
const protocol = "flows-atomic/1"
/** Room for `flows-atomic/1 <digits>\n` above the payload ceiling. */
const frameHeaderBytes = 64
/** The helper enforces the same ceiling before it trusts a declared limit. */
const hardLimitBytes = 256 * 1024 * 1024
/** An inert working directory: nothing the helper could import lives there. */
const inertDirectory = "/"
const decimal = /^[0-9]+$/
const fatalUtf8 = new TextDecoder("utf-8", { fatal: true })

/**
 * The errno-to-reason table `@effect/platform-node` applies to a Node
 * `ErrnoException`, so a caller reads the same typed reason it would get from
 * the native filesystem. `EPERM` and `ENOTSUP` are added because they are how
 * this helper reports its own refusals — outside the pinned root, a hard link,
 * a symlink, a special file, the root itself, or a host without
 * descriptor-relative POSIX. `EFBIG` and `ENXIO` are how it reports a payload
 * over the documented limit and a write-only open of a reader-less FIFO.
 * `EPROTO` is a framing failure and stays fail-closed. `EOPNOTSUPP` is the
 * same number as `ENOTSUP` on Linux, where which of the two names Python
 * reports for it is an implementation detail.
 */
const reasons: Record<string, PlatformError.SystemErrorTag | undefined> = {
  EACCES: "PermissionDenied",
  EBUSY: "Busy",
  EEXIST: "AlreadyExists",
  EFBIG: "BadResource",
  EISDIR: "BadResource",
  ELOOP: "BadResource",
  ENOENT: "NotFound",
  ENOTDIR: "BadResource",
  ENOTSUP: "PermissionDenied",
  ENXIO: "BadResource",
  EOPNOTSUPP: "PermissionDenied",
  EPERM: "PermissionDenied",
  EPROTO: "PermissionDenied"
}

/**
 * A rejection carrying no errno is a transport or host failure — an absent
 * interpreter, a killed child, output that is not a helper result — and stays
 * `PermissionDenied` so the boundary fails closed rather than reporting a
 * benign-looking reason for an operation that never ran.
 */
const failure = (
  request: KernelFileSystem.AtomicRequest,
  cause: unknown,
  rejection?: HelperResult
): PlatformError.PlatformError => {
  const method = request.operation
  if (rejection?.badArgument === true) {
    return PlatformError.badArgument({ module: moduleName, method, description: rejection.message, cause })
  }
  const code = rejection?.code ?? undefined
  return PlatformError.systemError({
    module: moduleName,
    method,
    pathOrDescriptor: request.path ?? request.from ?? request.pattern,
    _tag: code === undefined ? "PermissionDenied" : reasons[code] ?? "Unknown",
    // The cause is repeated into the description because a fail-closed refusal
    // that says only "failed closed" is unactionable: an absent interpreter, a
    // response over the limit, and a mangled frame all look alike otherwise.
    description: code === undefined
      ? `descriptor-relative filesystem isolation failed closed: ${String(cause)}`
      : rejection?.message,
    cause
  })
}

/**
 * True when `target` is at or below `root`. Both are absolute and already
 * canonical, and this module is POSIX-only, so `path.relative` answers with a
 * leading `..` for everything outside and never with an absolute path.
 */
const inside = (root: string, target: string): boolean => {
  const path = relative(root, target)
  return path === "" || (path !== ".." && !path.startsWith("../") && !isAbsolute(path))
}

/**
 * Resolves the configured interpreter to an absolute, executable regular file
 * that the confined workspace cannot have supplied. Every failure throws, and
 * every throw becomes a fail-closed `PermissionDenied`, so a host without a
 * usable interpreter performs no filesystem operation at all.
 */
const usableExecutable = (configured: string, boundaryRoot: string | undefined): string => {
  if (!isAbsolute(configured)) {
    throw new Error(`atomic helper executable must be an absolute path, got ${JSON.stringify(configured)}`)
  }
  // Resolved first: the checks below have to describe the file that will
  // actually run, not the name that leads to it.
  const resolved = realpathSync.native(configured)
  if (!statSync(resolved).isFile()) {
    throw new Error(`atomic helper executable is not a regular file: ${resolved}`)
  }
  accessSync(resolved, constants.X_OK)
  if (boundaryRoot !== undefined && inside(boundaryRoot, resolved)) {
    throw new Error(`atomic helper executable must live outside the confined workspace: ${resolved}`)
  }
  return resolved
}

/** Resolves every optional byte ceiling and refuses values that could disable a bound. */
const resolveLimits = (overrides: Partial<Limits> | undefined): Limits => {
  const limits: Limits = {
    content: overrides?.content ?? defaultLimits.content,
    request: overrides?.request ?? defaultLimits.request,
    response: overrides?.response ?? defaultLimits.response,
    stderr: overrides?.stderr ?? defaultLimits.stderr
  }
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > hardLimitBytes) {
      throw new Error(
        `atomic helper ${name} limit must be a positive integer no greater than ${hardLimitBytes}`
      )
    }
  }
  return limits
}

const decode = (frame: Buffer, limits: Limits): HelperResult => {
  const newline = frame.indexOf(10)
  if (newline < 0 || newline >= frameHeaderBytes) {
    throw new Error("atomic helper response is not framed")
  }
  const fields = frame.subarray(0, newline).toString("ascii").split(" ")
  if (fields.length !== 2 || fields[0] !== protocol) {
    throw new Error("atomic helper response carries an unknown protocol tag")
  }
  const declared = fields[1]!
  if (!decimal.test(declared)) {
    throw new Error(`atomic helper declared a non-decimal response length: ${declared}`)
  }
  const length = Number(declared)
  if (!Number.isSafeInteger(length) || length < 0 || length > limits.response) {
    throw new Error(`atomic helper declared an out-of-range response length: ${declared}`)
  }
  const body = frame.subarray(newline + 1)
  if (body.byteLength !== length) {
    // Fewer bytes is a truncated response (a killed helper); more is a second
    // frame appended to the first. Either way the stream is not one answer.
    throw new Error(`atomic helper declared ${length} response bytes and wrote ${body.byteLength}`)
  }
  // Decoded from the complete frame, so a multi-byte character split across
  // two stdout chunks is never mangled on the way in.
  const value = JSON.parse(fatalUtf8.decode(body)) as HelperResult
  if (value === null || typeof value !== "object" || typeof value.ok !== "boolean") {
    throw new Error("atomic helper response is not a result envelope")
  }
  if (value.code !== undefined && value.code !== null && typeof value.code !== "string") {
    throw new Error("atomic helper response carries a non-string error code")
  }
  if (value.badArgument !== undefined && typeof value.badArgument !== "boolean") {
    throw new Error("atomic helper response carries a non-boolean badArgument flag")
  }
  if (value.message !== undefined && typeof value.message !== "string") {
    throw new Error("atomic helper response carries a non-string message")
  }
  return value
}

const record = (value: unknown, what: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object") {
    throw new Error(`atomic helper returned a non-object ${what}`)
  }
  return value as Record<string, unknown>
}

const finite = (value: unknown, field: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`atomic helper returned a non-numeric ${field}`)
  }
  return value
}

const integer = (value: unknown, field: string): number => {
  const numeric = finite(value, field)
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new Error(`atomic helper returned an out-of-range ${field}: ${numeric}`)
  }
  return numeric
}

const date = (value: unknown, field: string): Date => {
  const result = new Date(finite(value, field))
  if (!Number.isFinite(result.getTime())) {
    throw new Error(`atomic helper returned an out-of-range ${field}`)
  }
  return result
}

const size = (value: unknown, field: string): FileSystem.Size => {
  if (typeof value === "string" && decimal.test(value)) {
    return FileSystem.Size(BigInt(value))
  }
  return FileSystem.Size(BigInt(integer(value, field)))
}

const optional = <A>(value: unknown, read: (value: unknown) => A): Option.Option<A> =>
  value === null || value === undefined ? Option.none() : Option.some(read(value))

/** Effect's own `FileSystem.File.Type`; anything else is a helper defect. */
const fileTypes = new Set<string>([
  "File",
  "Directory",
  "SymbolicLink",
  "BlockDevice",
  "CharacterDevice",
  "FIFO",
  "Socket",
  "Unknown"
])

const toInfo = (value: unknown): FileSystem.File.Info => {
  const info = record(value, "stat")
  if (!fileTypes.has(info.type as string)) {
    throw new Error(`atomic helper returned an unknown file type: ${String(info.type)}`)
  }
  return {
    type: info.type as FileSystem.File.Type,
    mtime: Option.some(date(info.mtime, "mtime")),
    atime: Option.some(date(info.atime, "atime")),
    birthtime: optional(info.birthtime, (raw) => date(raw, "birthtime")),
    dev: integer(info.dev, "dev"),
    ino: Option.some(integer(info.ino, "ino")),
    mode: integer(info.mode, "mode"),
    nlink: Option.some(integer(info.nlink, "nlink")),
    uid: Option.some(integer(info.uid, "uid")),
    gid: Option.some(integer(info.gid, "gid")),
    rdev: Option.some(integer(info.rdev, "rdev")),
    size: size(info.size, "size"),
    blksize: optional(info.blksize, (raw) => size(raw, "blksize")),
    blocks: optional(info.blocks, (raw) => integer(raw, "blocks"))
  }
}

const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

const toBytes = (value: unknown, limit: number): Uint8Array => {
  const payload = record(value, "read result")
  const encoded = payload.base64
  // Buffer.from silently drops characters it does not recognise, so the shape
  // is checked before the decode rather than inferred from its output.
  if (typeof encoded !== "string" || !base64Pattern.test(encoded)) {
    throw new Error("atomic helper returned a malformed base64 payload")
  }
  const bytes = Buffer.from(encoded, "base64")
  if (bytes.byteLength > limit) {
    throw new Error(`atomic helper returned ${bytes.byteLength} bytes, over the ${limit} byte read limit`)
  }
  return Uint8Array.from(bytes)
}

const toStringResult = (value: unknown, what: string): string => {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error(`atomic helper returned an invalid ${what}`)
  }
  return value
}

const maxListingEntries = 100_000

const toStringArray = (value: unknown, what: string): Array<string> => {
  if (!Array.isArray(value) || value.length > maxListingEntries) {
    throw new Error(`atomic helper returned an invalid ${what}`)
  }
  const result = value.map((entry) => toStringResult(entry, `${what} entry`))
  if (new Set(result).size !== result.length) {
    throw new Error(`atomic helper returned duplicate ${what} entries`)
  }
  return result
}

const convert = <A>(
  request: KernelFileSystem.AtomicRequest,
  value: unknown,
  limits: Limits
): Effect.Effect<A, PlatformError.PlatformError> => {
  if (request.operation === "readFile" || request.operation === "readFileString") {
    // An empty file encodes to an empty string, so the payload is read by
    // shape: truthiness would return the raw envelope for it instead.
    const bytes = toBytes(value, limits.content)
    if (request.operation === "readFile") {
      return Effect.succeed(bytes as A)
    }
    try {
      return Effect.succeed(new TextDecoder(request.encoding).decode(bytes) as A)
    } catch (cause) {
      // Effect's own `readFileString` reports a rejected encoding as a
      // BadArgument, not as a filesystem failure.
      return Effect.fail(PlatformError.badArgument({
        module: "FileSystem",
        method: "readFileString",
        description: "invalid encoding",
        cause
      }))
    }
  }
  if (request.operation === "stat") {
    return Effect.succeed(toInfo(value) as A)
  }
  if (request.operation === "exists") {
    if (typeof value !== "boolean") {
      throw new Error("atomic helper returned a non-boolean exists result")
    }
    return Effect.succeed(value as A)
  }
  if (request.operation === "readLink" || request.operation === "realPath") {
    return Effect.succeed(toStringResult(value, `${request.operation} result`) as A)
  }
  if (request.operation === "readDirectory" || request.operation === "glob") {
    return Effect.succeed(toStringArray(value, `${request.operation} result`) as A)
  }
  if (
    request.operation === "writeFile" ||
    request.operation === "writeFileString" ||
    request.operation === "makeDirectory" ||
    request.operation === "remove" ||
    request.operation === "rename"
  ) {
    if (value !== null) {
      throw new Error(`atomic helper returned a non-null ${request.operation} result`)
    }
    return Effect.succeed(undefined as A)
  }
  throw new Error(`atomic helper returned success for unsupported operation ${request.operation}`)
}

const spawnHelper = <A>(
  request: KernelFileSystem.AtomicRequest,
  executable: string,
  payload: Buffer,
  limits: Limits
): Effect.Effect<A, PlatformError.PlatformError> =>
  Effect.callback<A, PlatformError.PlatformError>((resume) => {
    let settled = false
    const stdout: Array<Buffer> = []
    let stdoutBytes = 0
    const stderr: Array<Buffer> = []
    let stderrBytes = 0
    let truncated = false
    let writeFailure: unknown

    // `-I` (isolated) and `-X utf8` are part of the boundary, not tuning.
    //
    // Without `-I`, `python3 -c` prepends the CURRENT WORKING DIRECTORY to
    // `sys.path`. A `base64.py` (or `re.py`, `stat.py`) reachable from there
    // is imported and executed by the helper — arbitrary code inside the
    // process that holds the pinned root descriptor. `-I` also implies `-E`,
    // so `PYTHONPATH` and `PYTHONSTARTUP` cannot reintroduce the same hijack
    // from the environment, and `-s`, so a user site directory cannot either.
    // The cost is that `PYTHONHOME` is ignored too: an interpreter that needs
    // it fails closed like any other unusable helper.
    //
    // `-X utf8` is a command-line option rather than `PYTHONUTF8`, because
    // `-E` would discard the environment variable. It pins stdio and the
    // filesystem encoding to UTF-8 so the request bytes, the path bytes the
    // syscalls receive, and the response all agree regardless of the locale.
    //
    // The inert cwd and the empty environment make those guarantees
    // structural rather than flag-deep: there is no ambient directory to
    // search and no variable to read, whichever interpreter is configured.
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(executable, ["-I", "-X", "utf8", "-c", helper], {
        cwd: inertDirectory,
        env: {},
        stdio: ["pipe", "pipe", "pipe"]
      })
    } catch (cause) {
      // libuv reports some exec failures — `ENOEXEC` for a file that is
      // neither a script nor a binary — by throwing rather than by emitting an
      // `error` event, so both arrivals have to end in the same refusal.
      resume(Effect.fail(failure(request, cause)))
      return Effect.void
    }
    const cleanup = () => {
      child.stdin.destroy()
      child.stdout.destroy()
      child.stderr.destroy()
      child.kill("SIGKILL")
    }
    const complete = (effect: Effect.Effect<A, PlatformError.PlatformError>) => {
      if (settled) return
      settled = true
      // Every exit path drains and kills, so an overflowing, hung, or already
      // finished helper leaves no descriptor and no child behind.
      cleanup()
      resume(effect)
    }
    // Raw buffers, never decoded strings: a chunk boundary in the middle of a
    // multi-byte character would otherwise be decoded as two replacement
    // characters before the JSON parse ever saw it. Concatenating once at the
    // end also keeps accumulation linear instead of quadratic.
    // Retained bytes are bounded by the ceiling plus at most one pipe chunk:
    // an overflowing chunk is sliced before it is retained, so the host never
    // relies on the stream implementation's chunk-size convention.
    child.stdout.on("data", (chunk: Buffer) => {
      const remaining = limits.response + frameHeaderBytes - stdoutBytes
      if (chunk.byteLength > remaining) {
        if (remaining > 0) {
          stdout.push(chunk.subarray(0, remaining))
          stdoutBytes += remaining
        }
        complete(Effect.fail(failure(
          request,
          new Error(`atomic helper wrote more than ${limits.response} response bytes`)
        )))
        return
      }
      stdoutBytes += chunk.byteLength
      stdout.push(chunk)
    })
    // stderr is bounded on its own budget: a helper that says nothing useful
    // on stdout must not be able to exhaust the host through diagnostics.
    // Destroying the pipe stops the helper at its next write rather than
    // letting it produce output nobody will read.
    child.stderr.on("data", (chunk: Buffer) => {
      // Sliced to the remaining room rather than kept whole, so the retained
      // text is exactly the budget and not the budget plus a pipe buffer.
      const slice = chunk.subarray(0, limits.stderr - stderrBytes)
      stderrBytes += slice.byteLength
      stderr.push(slice)
      if (stderrBytes >= limits.stderr) {
        truncated = true
        child.stderr.destroy()
      }
    })
    child.on("error", (cause) => complete(Effect.fail(failure(request, cause))))
    // A helper that exits before draining stdin — an unavailable interpreter,
    // a rejected request, an interrupt that killed it mid-write — makes the
    // request write fail with EPIPE. Without a listener that is an unhandled
    // `error` event on the pipe, which terminates the host process instead of
    // failing one filesystem call. It is recorded rather than resumed on, so
    // that a helper which did manage to report a real errno keeps precedence
    // over the broken pipe its own exit caused.
    child.stdin.on("error", (cause) => {
      writeFailure = cause
    })
    child.on("close", (code) => {
      let envelope: HelperResult | undefined
      let malformed: unknown
      try {
        envelope = decode(Buffer.concat(stdout), limits)
      } catch (cause) {
        malformed = cause
      }
      if (envelope !== undefined && !envelope.ok) {
        // The helper's own typed rejection outranks the exit status and any
        // transport noise: it is the only thing that knows which errno the
        // syscall produced.
        complete(Effect.fail(failure(
          request,
          new Error(envelope.message ?? "atomic helper rejected the operation"),
          envelope
        )))
        return
      }
      if (envelope !== undefined && code === 0) {
        try {
          complete(convert<A>(request, envelope.value, limits))
        } catch (cause) {
          complete(Effect.fail(failure(request, cause)))
        }
        return
      }
      const text = Buffer.concat(stderr).toString("utf8")
      complete(Effect.fail(failure(
        request,
        text !== ""
          ? new Error(`atomic helper exited ${code}: ${text}${truncated ? " (truncated)" : ""}`)
          : writeFailure !== undefined
          ? writeFailure
          : malformed !== undefined
          ? malformed
          : new Error(`atomic helper exited ${code}`)
      )))
    })
    child.stdin.end(payload)
    return Effect.sync(cleanup)
  })

const execute = (options: Options) =>
<A>(
  request: KernelFileSystem.AtomicRequest
): Effect.Effect<A, PlatformError.PlatformError> =>
  Effect.suspend(() => {
    let limits: Limits
    try {
      limits = resolveLimits(options.limits)
    } catch (cause) {
      return Effect.fail(PlatformError.badArgument({
        module: moduleName,
        method: request.operation,
        description: cause instanceof Error ? cause.message : "atomic helper limits are invalid",
        cause
      }))
    }
    let body: Buffer
    try {
      const serialized = JSON.stringify(request)
      if (serialized === undefined) {
        throw new Error("atomic request is not serializable")
      }
      body = Buffer.from(serialized, "utf8")
    } catch (cause) {
      return Effect.fail(PlatformError.badArgument({
        module: moduleName,
        method: request.operation,
        description: "atomic request is not serializable",
        cause
      }))
    }
    if (body.byteLength > limits.request) {
      // Refused before an interpreter exists: an over-limit request is caller
      // input, and nothing about it improves by being sent.
      return Effect.fail(PlatformError.badArgument({
        module: moduleName,
        method: request.operation,
        description: `atomic request of ${body.byteLength} bytes exceeds the ${limits.request} byte limit`
      }))
    }
    const header = Buffer.from(
      `${protocol} ${body.byteLength} ${limits.request} ${limits.content} ${limits.response}\n`,
      "ascii"
    )
    let executable: string
    try {
      executable = usableExecutable(options.executable ?? defaultExecutable, request.boundaryRoot)
    } catch (cause) {
      return Effect.fail(failure(request, cause))
    }
    return spawnHelper<A>(
      request,
      executable,
      Buffer.concat([header, body], header.byteLength + body.byteLength),
      limits
    )
  })

/**
 * A Node filesystem layer carrying the kernel's atomic host extension, built
 * against an explicitly configured interpreter and set of byte limits.
 *
 * @since 0.1.0
 * @category layers
 */
export const layerWith = (options: Options): Layer.Layer<FileSystem.FileSystem> =>
  Layer.effect(
    FileSystem.FileSystem,
    Effect.map(
      FileSystem.FileSystem,
      (fileSystem) => KernelFileSystem.withAtomicFileSystem(fileSystem, { execute: execute(options) })
    )
  ).pipe(Layer.provide(NodeFileSystem.layer))

/** A Node filesystem layer carrying the kernel's atomic host extension.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer: Layer.Layer<FileSystem.FileSystem> = layerWith({})
