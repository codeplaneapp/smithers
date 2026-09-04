#!/usr/bin/env node
/**
 * add-readme-doc-links.mjs
 *
 * One-shot: inserts `**Documentation:** https://<slug>.smithers.sh` near the
 * top of each manifest package's README.md, right after the H1, and creates
 * a minimal README (name, description, Documentation line) for a package
 * that has none. Idempotent: a README already carrying the URL is skipped.
 *
 * This is deliberately not part of gen-sites.mjs: the line joins the
 * package's own prose, authored and reviewed there, not generator-owned
 * boilerplate a regeneration would splice.
 *
 * Usage: node apps/docs/shared/add-readme-doc-links.mjs
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { repoRoot, sites } from "./manifest.mjs"

let inserted = 0
let created = 0
let skipped = 0

for (const site of sites) {
  const url = `https://${site.domain}`
  const line = `**Documentation:** ${url}`
  const readmePath = join(repoRoot, site.dir, "README.md")
  if (!existsSync(readmePath)) {
    writeFileSync(readmePath, `# ${site.name}\n\n${site.description}\n\n${line}\n`)
    created++
    console.log(`created: ${site.dir}/README.md`)
    continue
  }
  const text = readFileSync(readmePath, "utf8")
  // Idempotent on the line itself, not the bare URL: a package may already
  // name its smithers.sh subdomain for another purpose (the @smthrs/build
  // README configures https://build.smithers.sh as its cache endpoint).
  if (text.includes(line)) {
    skipped++
    continue
  }
  // After the H1 and its following blank line; a README without an H1 (none
  // in the manifest) gets the line at the top.
  const h1 = text.match(/^#[^\n]*\n+/)
  const next = h1 ? `${h1[0]}${line}\n\n${text.slice(h1[0].length)}` : `${line}\n\n${text}`
  writeFileSync(readmePath, next)
  inserted++
  console.log(`inserted: ${site.dir}/README.md`)
}

console.log(`add-readme-doc-links: ${inserted} inserted, ${created} created, ${skipped} already linked`)
