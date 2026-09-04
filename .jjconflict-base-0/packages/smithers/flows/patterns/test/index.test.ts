import { describe, it } from "@effect/vitest"
import { readdirSync } from "node:fs"
import { basename, join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect } from "vitest"
import * as Patterns from "../src/index.ts"

const sourceDirectory = fileURLToPath(new URL("../src/", import.meta.url))

const moduleNames = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return entry.name === "internal" ? [] : moduleNames(join(directory, entry.name))
    }
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name === "index.ts") return []
    return [basename(entry.name, ".ts")]
  })

describe("package barrel", () => {
  it("exports every public source module as a defined namespace", () => {
    const barrel: Readonly<Record<string, unknown>> = Patterns

    for (const name of moduleNames(sourceDirectory)) {
      expect(barrel).toHaveProperty(name)
      expect(typeof barrel[name]).toBe("object")
    }
    for (const namespace of Object.values(barrel)) {
      expect(namespace).not.toBeUndefined()
    }
  })
})
