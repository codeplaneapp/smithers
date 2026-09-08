import { describe, expect, it } from "@effect/vitest"
import { readFileSync } from "node:fs"

describe("time-travel package contract", () => {
  it("registers the durable-identity review for its persisted migrations and keys", () => {
    const declaration = readFileSync(new URL("../PACKAGE.ts", import.meta.url), "utf8")
    expect(declaration).toMatch(
      /import\s*\{[^}]*\bReviewTagsMigrationsAndKeys\b[^}]*\}\s*from\s*"@smthrs\/repo-targets"/
    )
    expect(declaration).toMatch(
      /const\s+reviewTagsMigrationsAndKeys\s*=\s*ReviewTagsMigrationsAndKeys\(\{\s*cwd:\s*"packages\/smithers\/flows\/time-travel"\s*\}\)/
    )
    expect(declaration).toMatch(/targets:\s*\{[^}]*\breviewTagsMigrationsAndKeys\b/)
  })

  it("does not declare the unused capability development dependency", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
    expect(manifest.devDependencies).not.toHaveProperty("@smthrs/capability")
  })
})
