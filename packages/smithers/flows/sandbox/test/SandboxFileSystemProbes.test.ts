import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, PlatformError } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll } from "vitest"
import * as DirectorySandbox from "../src/DirectorySandbox/index.ts"
import * as Sandbox from "../src/Sandbox/index.ts"
import { platform } from "./helpers/containedPlatform.ts"

// The suite pins the probe dialect to its reference: every operation runs
// twice on the same real directory tree — once through `Sandbox.fileSystem`'s
// sh probes over a real host shell, once through the platform NodeFileSystem —
// and must come back with the same `PlatformError` reason (or the same
// success). A probe that drifts from the platform implementation fails here
// against the implementation itself, not against a transcript of it.

// The resolved root keeps macOS's symlinked temp tree from making the shell
// and the reference disagree about what a path names.
const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-fs-probes-")))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const services = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner
  return { fs, spawner }
}).pipe(Effect.provide(platform))

/** The outcome under comparison: `success`, or the failure's reason tag. */
const outcomeOf = <A>(operation: Effect.Effect<A, PlatformError.PlatformError>): Effect.Effect<string> =>
  Effect.match(operation, {
    onSuccess: () => "success",
    onFailure: (error) => error.reason._tag
  })

/**
 * Runs the same operation through the probe surface and the reference
 * filesystem and requires the identical, pinned outcome from both, so the
 * expectation cannot drift from what NodeFileSystem actually reports.
 */
const agreement = (
  expected: string,
  probed: Effect.Effect<unknown, PlatformError.PlatformError>,
  reference: Effect.Effect<unknown, PlatformError.PlatformError>
): Effect.Effect<void> =>
  Effect.gen(function*() {
    const outcome = { probe: yield* outcomeOf(probed), node: yield* outcomeOf(reference) }
    expect(outcome).toEqual({ probe: expected, node: expected })
  })

const withProbes = <A, E>(
  session: string,
  body: (tree: {
    probed: FileSystem.FileSystem
    fs: FileSystem.FileSystem
    workdir: string
  }) => Effect.Effect<A, E>
) =>
  Effect.gen(function*() {
    const { fs, spawner } = yield* services
    const provider = DirectorySandbox.make({ fs, spawner, root })
    return yield* Effect.scoped(
      Effect.gen(function*() {
        const acquired = yield* provider.acquire(session)
        // Stripping the native overrides forces every derived operation
        // through the sh probes, over the same tree the reference reads.
        const probed = Sandbox.fileSystem({ ...acquired, files: undefined })
        return yield* body({ probed, fs, workdir: acquired.workdir })
      })
    )
  })

// Each check spawns a handful of real shells; a loaded machine still fits.
const budget = 30_000

const isRoot = globalThis.process.getuid?.() === 0

describe("Sandbox.fileSystem probes against the reference filesystem", () => {
  it.effect(
    "refuses a rename onto an existing directory instead of moving into it",
    () =>
      withProbes("rename-onto-dir", ({ fs, probed, workdir }) =>
        Effect.gen(function*() {
          yield* fs.writeFileString(`${workdir}/f.txt`, "payload")
          yield* fs.makeDirectory(`${workdir}/dest`)
          // Bare `mv` would land the file at `dest/f.txt`; `rename(2)` refuses
          // with EISDIR.
          yield* agreement(
            "BadResource",
            probed.rename(`${workdir}/f.txt`, `${workdir}/dest`),
            fs.rename(`${workdir}/f.txt`, `${workdir}/dest`)
          )
          // The refusal really came before `mv` ran: nothing moved.
          expect(yield* fs.exists(`${workdir}/f.txt`)).toBe(true)
          expect(yield* fs.exists(`${workdir}/dest/f.txt`)).toBe(false)
        })),
    budget
  )

  it.effect(
    "reports a rename's missing source as NotFound",
    () =>
      withProbes("rename-missing-source", ({ fs, probed, workdir }) =>
        agreement(
          "NotFound",
          probed.rename(`${workdir}/ghost`, `${workdir}/target`),
          fs.rename(`${workdir}/ghost`, `${workdir}/target`)
        )),
    budget
  )

  it.effect(
    "reports an occupied makeDirectory target as AlreadyExists, in both modes",
    () =>
      withProbes("mkdir-occupied", ({ fs, probed, workdir }) =>
        Effect.gen(function*() {
          yield* fs.makeDirectory(`${workdir}/held`)
          yield* fs.writeFileString(`${workdir}/f.txt`, "occupant")
          yield* agreement(
            "AlreadyExists",
            probed.makeDirectory(`${workdir}/held`),
            fs.makeDirectory(`${workdir}/held`)
          )
          yield* agreement(
            "AlreadyExists",
            probed.makeDirectory(`${workdir}/f.txt`),
            fs.makeDirectory(`${workdir}/f.txt`)
          )
          // Recursive creation of an existing directory is a success, and only
          // a non-directory occupant still refuses.
          yield* agreement(
            "success",
            probed.makeDirectory(`${workdir}/held`, { recursive: true }),
            fs.makeDirectory(`${workdir}/held`, { recursive: true })
          )
          yield* agreement(
            "AlreadyExists",
            probed.makeDirectory(`${workdir}/f.txt`, { recursive: true }),
            fs.makeDirectory(`${workdir}/f.txt`, { recursive: true })
          )
        })),
    budget
  )

  it.effect(
    "reports a makeDirectory with a missing parent as NotFound",
    () =>
      withProbes("mkdir-orphan", ({ fs, probed, workdir }) =>
        agreement(
          "NotFound",
          probed.makeDirectory(`${workdir}/no/deep`),
          fs.makeDirectory(`${workdir}/no/deep`)
        )),
    budget
  )

  it.effect(
    "reports a missing or dangling realPath as NotFound",
    () =>
      withProbes("realpath-absent", ({ fs, probed, workdir }) =>
        Effect.gen(function*() {
          yield* agreement(
            "NotFound",
            probed.realPath(`${workdir}/ghost`),
            fs.realPath(`${workdir}/ghost`)
          )
          // `readlink -f` alone would exit 0 and print the missing path; a
          // dangling symlink is equally absent to the reference `realpath`.
          yield* fs.symlink(`${workdir}/ghost`, `${workdir}/dangling`)
          yield* agreement(
            "NotFound",
            probed.realPath(`${workdir}/dangling`),
            fs.realPath(`${workdir}/dangling`)
          )
        })),
    budget
  )

  it.effect(
    "reports a missing readLink as NotFound and keeps BadArgument for a non-link",
    () =>
      withProbes("readlink-shapes", ({ fs, probed, workdir }) =>
        Effect.gen(function*() {
          yield* agreement(
            "NotFound",
            probed.readLink(`${workdir}/ghost`),
            fs.readLink(`${workdir}/ghost`)
          )
          // The one pinned divergence on the whole surface: a present non-link
          // is the caller's misuse, which the probe names `BadArgument` where
          // the reference lets the unmapped `EINVAL` fall through as `Unknown`.
          // `fileSystem`'s docs declare exactly this.
          yield* fs.writeFileString(`${workdir}/plain.txt`, "not a link")
          const nonLink = {
            probe: yield* outcomeOf(probed.readLink(`${workdir}/plain.txt`)),
            node: yield* outcomeOf(fs.readLink(`${workdir}/plain.txt`))
          }
          expect(nonLink).toEqual({ probe: "BadArgument", node: "Unknown" })
        })),
    budget
  )

  it.effect(
    "reports a readDirectory of a regular file as BadResource",
    () =>
      withProbes("readdir-of-file", ({ fs, probed, workdir }) =>
        Effect.gen(function*() {
          yield* fs.writeFileString(`${workdir}/f.txt`, "not a directory")
          yield* agreement(
            "BadResource",
            probed.readDirectory(`${workdir}/f.txt`),
            fs.readDirectory(`${workdir}/f.txt`)
          )
          yield* agreement(
            "BadResource",
            probed.readDirectory(`${workdir}/f.txt`, { recursive: true }),
            fs.readDirectory(`${workdir}/f.txt`, { recursive: true })
          )
        })),
    budget
  )

  it.effect(
    "fails exists under a non-directory ancestor the way the reference access does",
    () =>
      withProbes("exists-under-file", ({ fs, probed, workdir }) =>
        Effect.gen(function*() {
          yield* fs.writeFileString(`${workdir}/f.txt`, "in the way")
          // The platform `exists` converts only NotFound into `false`; the
          // ENOTDIR from `access(2)` propagates as BadResource.
          yield* agreement(
            "BadResource",
            probed.exists(`${workdir}/f.txt/under`),
            fs.exists(`${workdir}/f.txt/under`)
          )
        })),
    budget
  )

  // Root sees through a 000-mode directory, so the denial only exists for an
  // unprivileged run — where it must match the reference's PermissionDenied.
  it.effect.skipIf(isRoot)(
    "fails exists behind an unsearchable directory with PermissionDenied",
    () =>
      withProbes("exists-denied", ({ fs, probed, workdir }) =>
        Effect.gen(function*() {
          yield* fs.makeDirectory(`${workdir}/vault`)
          yield* fs.writeFileString(`${workdir}/vault/inside.txt`, "sealed")
          yield* fs.chmod(`${workdir}/vault`, 0o000)
          yield* agreement(
            "PermissionDenied",
            probed.exists(`${workdir}/vault/inside.txt`),
            fs.exists(`${workdir}/vault/inside.txt`)
          ).pipe(
            // Reopen the vault whatever happened, or teardown cannot remove it.
            Effect.ensuring(Effect.orDie(fs.chmod(`${workdir}/vault`, 0o755)))
          )
        })),
    budget
  )
})
