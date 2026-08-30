/**
 * The shared setup of the two hard-kill cases.
 *
 * @since 1.0.0
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { FlowOptions } from "./killResumeFlow.ts"

/**
 * A scratch tree for one hard-kill case.
 *
 * @since 1.0.0
 * @category models
 */
export interface KillResumeFixture extends FlowOptions {
  readonly directory: string
  readonly executionId: string
  /** The append-only execution counter, as lines. */
  readonly counter: () => ReadonlyArray<string>
  /** Reads one marker file, or `undefined` when it has not been written. */
  readonly marker: (name: string) => string | undefined
}

/**
 * Creates the scratch tree.
 *
 * @since 1.0.0
 * @category constructors
 */
export const killResumeFixture = (label: string, secondSleepMs: number): KillResumeFixture => {
  const directory = mkdtempSync(join(tmpdir(), `smithers-e2e-${label}-`))
  const markerDir = join(directory, "markers")
  mkdirSync(markerDir, { recursive: true })
  const counterFile = join(directory, "executions.log")
  writeFileSync(counterFile, "")
  return {
    directory,
    filename: join(directory, "run.sqlite"),
    markerDir,
    counterFile,
    secondSleepMs,
    hostId: `${label}-host`,
    executionId: `${label}-run`,
    counter: () =>
      readFileSync(counterFile, "utf8").split("\n").map((line) => line.trim()).filter((line) => line.length > 0),
    marker: (name) => {
      try {
        return readFileSync(join(markerDir, name), "utf8")
      } catch {
        return undefined
      }
    }
  }
}
