/**
 * Type-checks a consumer that names the package's public types through the
 * PUBLISHED export map.
 *
 * The two sibling fixtures import `dist/` by path, which proves the built
 * JavaScript keeps one constructor identity but says nothing about what a
 * consumer can resolve. `WriteRetryOptions` exists so a caller can name the
 * options `make` and `layer` accept, and a relative import of `src/` proves
 * nothing about that: it resolved before the type was exported. This builds a
 * throwaway project whose `node_modules/@smthrs/database` carries the manifest
 * npm publishes — `publishConfig.exports` promoted to `exports` — and runs the
 * package's own `tsc` over a file that imports the type by subpath.
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"))
const project = mkdtempSync(join(tmpdir(), "flows-database-types-"))

/** The dependencies the emitted declarations import from. */
const linked = ["effect", "@effect/sql-sqlite-node"]

try {
  const modules = join(project, "node_modules")
  const packaged = join(modules, ...manifest.name.split("/"))
  mkdirSync(packaged, { recursive: true })
  writeFileSync(
    join(packaged, "package.json"),
    `${
      JSON.stringify(
        {
          name: manifest.name,
          version: manifest.version,
          type: manifest.type,
          // Exactly what npm writes into the published manifest.
          exports: manifest.publishConfig.exports
        },
        undefined,
        2
      )
    }\n`
  )
  symlinkSync(join(packageRoot, "dist"), join(packaged, "dist"))
  for (const dependency of linked) {
    const target = realpathSync(join(packageRoot, "node_modules", dependency))
    mkdirSync(join(modules, dirname(dependency)), { recursive: true })
    symlinkSync(target, join(modules, dependency))
  }

  writeFileSync(
    join(project, "consumer.ts"),
    [
      `import type { WriteRetryOptions } from "${manifest.name}/DurableWriter"`,
      "",
      "const options: WriteRetryOptions = { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 }",
      "",
      "// Fails to compile if the subpath resolved to `any`: the assignment would",
      "// then be legal and the expected error would never arrive.",
      "// @ts-expect-error a retry count is a number, not its decimal string",
      "const wrong: WriteRetryOptions = { maxAttempts: \"3\" }",
      "",
      "export const attempts: number | undefined = options.maxAttempts",
      "export const rejected: WriteRetryOptions = wrong",
      ""
    ].join("\n")
  )
  writeFileSync(
    join(project, "tsconfig.json"),
    `${
      JSON.stringify(
        {
          compilerOptions: {
            module: "nodenext",
            moduleResolution: "nodenext",
            target: "es2022",
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            types: []
          },
          files: ["consumer.ts"]
        },
        undefined,
        2
      )
    }\n`
  )

  execFileSync(
    process.execPath,
    [join(packageRoot, "node_modules", "typescript", "bin", "tsc"), "-p", join(project, "tsconfig.json")],
    { stdio: "inherit" }
  )
} finally {
  rmSync(project, { recursive: true, force: true })
}
