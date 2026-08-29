/**
 * Operator entry point for durable-store disaster recovery: hot-backs-up a
 * live flows SQLite store together with its artifact objects, verifies a
 * backup's recorded digests, and restores a backup into a fresh store
 * directory with every pre-backup ownership fence invalidated. The mechanics
 * live in `@smthrs/engine-store/DisasterRecovery`; this script only
 * parses arguments and composes the Node host layers. Cadence and procedure:
 * `docs/pages/disaster-recovery.md`.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { DurableWriter } from "@smthrs/database"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as DisasterRecovery from "@smthrs/engine-store/DisasterRecovery"
import { Effect, Layer } from "effect"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

const usage = `usage:
  node scripts/flows-backup.mjs backup <database-file> <backup-directory> [objects-directory]
  node scripts/flows-backup.mjs verify <backup-directory>
  node scripts/flows-backup.mjs restore <backup-directory> <target-directory>`

/** Parses `process.argv.slice(2)` into one of the three invocations. */
export const parseArguments = (argv) => {
  const [command, first, second, third] = argv
  if (command === "backup" && first !== undefined && second !== undefined && argv.length <= 4) {
    return { command, databaseFile: first, backupDirectory: second, objectsDirectory: third }
  }
  if (command === "verify" && first !== undefined && argv.length === 2) {
    return { command, backupDirectory: first }
  }
  if (command === "restore" && first !== undefined && second !== undefined && argv.length === 3) {
    return { command, backupDirectory: first, targetDirectory: second }
  }
  throw new Error(usage)
}

const host = Layer.mergeAll(NodeFileSystem.layer, NodeCrypto.layer)

/** Builds the Effect for one parsed invocation. Returns the operator summary line. */
export const program = (invocation) => {
  switch (invocation.command) {
    case "backup":
      return DisasterRecovery.backup({
        directory: invocation.backupDirectory,
        objectsDirectory: invocation.objectsDirectory
      }).pipe(
        Effect.provide(Layer.mergeAll(host, NodeDatabase.layer({ filename: invocation.databaseFile }))),
        Effect.map((manifest) =>
          `backed up ${manifest.database.sizeBytes} database bytes ` +
          `(sha256 ${manifest.database.sha256}) and ${manifest.artifacts.length} artifact blobs ` +
          `into ${invocation.backupDirectory}`
        )
      )
    case "verify":
      return DisasterRecovery.verify(invocation.backupDirectory).pipe(
        Effect.provide(host),
        Effect.map((manifest) =>
          `backup verified: database sha256 ${manifest.database.sha256}, ` +
          `${manifest.artifacts.length} artifact blobs, captured at ${new Date(manifest.createdAtMs).toISOString()}`
        )
      )
    case "restore":
      return DisasterRecovery.restoreAndFence({
        backupDirectory: invocation.backupDirectory,
        targetDirectory: invocation.targetDirectory,
        databaseLayer: (databaseFile) =>
          Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename: databaseFile }))
      }).pipe(
        Effect.provide(host),
        Effect.map((restored) =>
          `restored ${invocation.backupDirectory} into ${invocation.targetDirectory} and fenced it: ` +
          `${restored.fence.suspendedRuns} running runs suspended, ${restored.fence.clearedClaims} claims cleared`
        )
      )
  }
}

const isMain = process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (isMain) {
  console.log(await Effect.runPromise(program(parseArguments(process.argv.slice(2)))))
}
