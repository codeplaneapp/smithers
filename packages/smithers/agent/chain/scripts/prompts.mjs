// Compiles prompts/*.mdx into src/internal/prompts.ts — a generated,
// checked-in module — so the package composes prompt sections with no
// runtime filesystem read and stays browser-safe. A sync test in
// test/Prompt.test.ts fails the gate whenever the MDX sources and the
// generated module drift; run `npm run prompts` after editing any MDX.
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const promptsDir = join(root, "prompts")
const target = join(root, "src", "internal", "prompts.ts")

const sources = readdirSync(promptsDir).filter((name) => name.endsWith(".mdx")).sort()

const sections = sources.map((file) => {
  const name = file.slice(0, -".mdx".length)
  if (!/^[a-z][a-zA-Z0-9]*$/.test(name)) {
    throw new Error(`prompt file name must be a valid identifier: ${file}`)
  }
  // One trailing newline is the file convention, not prompt content.
  const text = readFileSync(join(promptsDir, file), "utf8").replace(/\n$/, "")
  return { name, text }
})

const header = `/**
 * GENERATED from prompts/*.mdx by scripts/prompts.mjs — do not edit.
 * Edit the MDX sources and run \`npm run prompts\`; the sync test in
 * test/Prompt.test.ts fails whenever this file and the sources drift.
 *
 * @since 0.1.0
 */
`

// Matches dprint's wrapping of over-long assignments so regeneration is
// byte-idempotent against the formatted, checked-in module.
const declaration = (name, text) => {
  const single = `export const ${name} = ${JSON.stringify(text)}`
  return single.length <= 120 ? single : `export const ${name} =\n  ${JSON.stringify(text)}`
}

const block = (name) =>
  `/**
 * The \`${name}\` prompt section, compiled from \`prompts/${name}.mdx\`.
 *
 * @category sections
 * @since 0.1.0
 */`

const body = sections
  .map((section) => `${block(section.name)}\n${declaration(section.name, section.text)}\n`)
  .join("\n")

writeFileSync(target, `${header}\n${body}`)
console.log(`wrote ${target} from ${sections.length} MDX sources`)
