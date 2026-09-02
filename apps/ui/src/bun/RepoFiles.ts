/*
 * Files in an open repository, read by the main process for the files seam
 * (`POST /api/repo/files`). The renderer names a repoId and a relative path;
 * this module owns the one rule that keeps the read inside the repository:
 * the path is split into plain segments (no `..`, no absolute prefix, no
 * NUL), joined under the root, and its REAL path must still sit under the
 * root — a symlink that points out of the checkout is refused, not followed.
 * Reads are bounded (REPO_FILE_READ_CAP_BYTES) and binary is stated, never
 * printed.
 */
import { open, readdir, realpath, stat } from "node:fs/promises"
import { join, sep } from "node:path"
import { REPO_FILE_READ_CAP_BYTES } from "smithers-shared/LocalApp"
import type { RepoFileEntry, RepoFilesResponse } from "smithers-shared/LocalApp"

export type RepoFilesResult =
  | { readonly status: "ok"; readonly body: RepoFilesResponse }
  | {
    readonly status: "error"
    readonly http: 400 | 403 | 404 | 500
    readonly code: "invalid_path" | "path_outside_repository" | "path_not_found" | "read_failed"
    readonly message: string
  }

const refuse = (
  http: 400 | 403 | 404 | 500,
  code: Extract<RepoFilesResult, { status: "error" }>["code"],
  message: string
): RepoFilesResult => ({ status: "error", http, code, message })

/**
 * The relative path as plain segments, or null when it cannot be one:
 * absolute, `.`/`..` segments, NUL, or a backslash-separated escape.
 */
export const repoPathSegments = (path: string): ReadonlyArray<string> | null => {
  if (path.includes("\0")) return null
  const normalized = path.replace(/\\/g, "/").trim()
  const segments = normalized.split("/").filter((segment) => segment !== "")
  for (const segment of segments) {
    if (segment === "." || segment === "..") return null
  }
  return segments
}

const insideRoot = (root: string, candidate: string): boolean => candidate === root || candidate.startsWith(`${root}${sep}`)

const entryKind = async (directory: string, name: string): Promise<RepoFileEntry["kind"] | null> => {
  try {
    const facts = await stat(join(directory, name))
    return facts.isDirectory() ? "dir" : facts.isFile() ? "file" : null
  } catch {
    return null
  }
}

const decodeText = (bytes: Uint8Array, truncated: boolean): { readonly content: string; readonly binary: boolean } => {
  if (bytes.includes(0)) return { content: "", binary: true }
  try {
    // A cut can land inside a multi-byte character: only a complete read is held to strict UTF-8.
    return { content: new TextDecoder("utf-8", { fatal: !truncated }).decode(bytes), binary: false }
  } catch {
    return { content: "", binary: true }
  }
}

/** Read a directory or a file under `root` (a real path) at the relative `path`. */
export const readRepoPath = async (root: string, path: string): Promise<RepoFilesResult> => {
  const segments = repoPathSegments(path)
  if (segments === null) return refuse(400, "invalid_path", "File paths must stay inside the repository.")
  const relative = segments.join("/")
  const candidate = join(root, ...segments)
  let real: string
  try {
    real = await realpath(candidate)
  } catch {
    return refuse(404, "path_not_found", `Path not found: ${relative === "" ? "/" : relative}`)
  }
  if (!insideRoot(root, real)) {
    return refuse(403, "path_outside_repository", `${relative} points outside the repository.`)
  }
  let facts: Awaited<ReturnType<typeof stat>>
  try {
    facts = await stat(real)
  } catch {
    return refuse(404, "path_not_found", `Path not found: ${relative === "" ? "/" : relative}`)
  }
  if (facts.isDirectory()) {
    let names: ReadonlyArray<string>
    try {
      names = await readdir(real)
    } catch (error) {
      return refuse(500, "read_failed", error instanceof Error ? error.message : String(error))
    }
    const entries: Array<RepoFileEntry> = []
    for (const name of names) {
      const kind = await entryKind(real, name)
      // A symlink out of the repository lists, but a read of it is refused above.
      if (kind !== null) entries.push({ name, kind })
    }
    entries.sort((left, right) =>
      left.kind !== right.kind ? (left.kind === "dir" ? -1 : 1) : left.name.localeCompare(right.name)
    )
    return { status: "ok", body: { kind: "dir", path: relative, entries } }
  }
  if (!facts.isFile()) return refuse(404, "path_not_found", `${relative} is not a file or directory.`)
  const size = facts.size
  const truncated = size > REPO_FILE_READ_CAP_BYTES
  const length = Math.min(size, REPO_FILE_READ_CAP_BYTES)
  const bytes = new Uint8Array(length)
  try {
    const handle = await open(real, "r")
    try {
      let offset = 0
      while (offset < length) {
        const { bytesRead } = await handle.read(bytes, offset, length - offset, offset)
        if (bytesRead === 0) break
        offset += bytesRead
      }
    } finally {
      await handle.close()
    }
  } catch (error) {
    return refuse(500, "read_failed", error instanceof Error ? error.message : String(error))
  }
  const { content, binary } = decodeText(bytes, truncated)
  return { status: "ok", body: { kind: "file", path: relative, size, content, truncated: binary ? false : truncated, binary } }
}
