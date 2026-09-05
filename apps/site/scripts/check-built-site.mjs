#!/usr/bin/env node
/** Check links and assets in every built page, including archived releases. */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../dist")
const pages = new Map()
const failures = new Set()
const decode = (value) => value.replaceAll("&amp;", "&").replaceAll("&#39;", "'").replaceAll("&quot;", '"')
function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) walk(path)
    else if (entry.name.endsWith(".html")) {
      const html = readFileSync(path, "utf8")
      pages.set(path, {
        ids: new Set([...html.matchAll(/\bid="([^"]*)"/g)].map((match) => decode(match[1]))),
        references: [...html.matchAll(/\b(?:href|src)="([^"]*)"/g)].map((match) => decode(match[1]))
      })
    }
  }
}
if (!existsSync(root)) throw new Error("Build the site before checking its links")
walk(root)
for (const [page, { references }] of pages) {
  for (const reference of references) {
    if (!reference.startsWith("/") || reference.startsWith("//")) continue
    const url = new URL(reference, "https://smithers.sh")
    let target = join(root, decodeURIComponent(url.pathname))
    if (existsSync(target) && statSync(target).isDirectory()) target = join(target, "index.html")
    if (!existsSync(target)) failures.add(`${relative(root, page)}: missing ${reference}`)
    else if (url.hash && pages.has(target) && !pages.get(target).ids.has(decodeURIComponent(url.hash.slice(1)))) {
      failures.add(`${relative(root, page)}: missing anchor ${reference}`)
    }
  }
}
for (const failure of failures) console.error(failure)
console.log(`check-built-site: ${pages.size} pages, ${failures.size} failures`)
if (failures.size) process.exitCode = 1
