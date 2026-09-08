/**
 * Type-checks a consumer that names the package's public types through the
 * PUBLISHED export map, once per module mode that map serves.
 *
 * The two sibling fixtures import `dist/` by path, which proves the built
 * JavaScript keeps one constructor identity but says nothing about what a
 * consumer can resolve. `WriteRetryOptions` exists so a caller can name the
 * options `make` and `layer` accept, and a relative import of `src/` proves
 * nothing about that: it resolved before the type was exported. This builds a
 * throwaway project whose `node_modules/@smthrs/database` carries the manifest
 * npm publishes — `publishConfig.exports` promoted to `exports` — and runs the
 * package's own `tsc` over files that import from it by subpath.
 *
 * One case per condition the map advertises. The ESM case reads the `import`
 * condition; the CommonJS case reads `require`, and it is a `.cts` value
 * import under `module: node16` because that is the one configuration that
 * reports TS1479 when a CommonJS runtime entry is paired with ESM-flavored
 * declarations. A type-only import does not reach that check, so the ESM-only
 * declarations the package shipped before passed a type-only consumer while
 * failing every typed CommonJS one.
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

/**
 * `execFileSync` blocks this process, so a wedged compiler is not something the
 * suite's own timeout can interrupt: only the child's kills it. A cold `tsc` is
 * ~4 s here, and the two runs together stay inside the 60 s the suite allows
 * this fixture.
 */
const compilerTimeoutMs = 25_000

/** One consumer per module resolution mode the published map has to serve. */
const consumers = [
  {
    file: "consumer.ts",
    config: "tsconfig.esm.json",
    module: "nodenext",
    source: [
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
    ]
  },
  {
    file: "consumer.cts",
    config: "tsconfig.cjs.json",
    module: "node16",
    source: [
      `import { makeNoop } from "${manifest.name}/DurableWriter"`,
      "",
      "// A value import, not a type import. This is the line that reads the",
      "// declarations behind the `require` condition, and it is TS1479 when",
      "// those declarations are the ESM ones: a CommonJS file cannot import an",
      "// ECMAScript module. `import type` never reaches that check.",
      "export const service = makeNoop()",
      "",
      "// Fails to compile if the require condition resolved to `any`: the",
      "// annotation would then be legal and the expected error never arrives.",
      "// @ts-expect-error a write service is not its name",
      "export const wrong: string = makeNoop()",
      ""
    ]
  }
]

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

  for (const consumer of consumers) {
    writeFileSync(join(project, consumer.file), consumer.source.join("\n"))
    writeFileSync(
      join(project, consumer.config),
      `${
        JSON.stringify(
          {
            compilerOptions: {
              module: consumer.module,
              moduleResolution: consumer.module,
              target: "es2022",
              strict: true,
              noEmit: true,
              skipLibCheck: true,
              types: []
            },
            files: [consumer.file]
          },
          undefined,
          2
        )
      }\n`
    )
    execFileSync(
      process.execPath,
      [join(packageRoot, "node_modules", "typescript", "bin", "tsc"), "-p", join(project, consumer.config)],
      { stdio: "inherit", timeout: compilerTimeoutMs, killSignal: "SIGKILL" }
    )
  }
} finally {
  rmSync(project, { recursive: true, force: true })
}
