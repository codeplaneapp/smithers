/**
 * Private SQLite persistence shared by local control and operator commands.
 * @since 1.0.0
 */
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { Effect, Layer } from "effect"
import { chmodSync, existsSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import * as ControlDatabaseMigrations from "./ControlDatabaseMigrations.ts"

/**
 * Opens private state and applies the complete control schema on acquisition.
 * Suspended so describing a layer leaves no directory or database behind.
 * @category layers
 * @since 1.0.0
 */
export const layer = (file: string) =>
  Layer.provideMerge(
    ControlDatabaseMigrations.layer,
    Layer.provideMerge(
      DurableWriter.layer(),
      Layer.suspend(() => {
        const stateDirectory = dirname(file)
        mkdirSync(stateDirectory, { recursive: true, mode: 0o700 })
        if (process.platform !== "win32") chmodSync(stateDirectory, 0o700)
        return NodeDatabase.layer({ filename: file })
      })
    )
  ).pipe(
    Layer.tap(() =>
      Effect.sync(() => {
        if (process.platform === "win32") return
        for (const sqliteFile of [file, `${file}-wal`, `${file}-shm`]) {
          if (existsSync(sqliteFile)) chmodSync(sqliteFile, 0o600)
        }
      })
    )
  )
