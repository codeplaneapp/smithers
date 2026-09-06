#!/usr/bin/env node
/** Check built links, assets, redirects, and URLs emitted outside the site. */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const siteRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const origin = "https://smithers.sh"
const decode = (value) => value.replaceAll("&amp;", "&").replaceAll("&#39;", "'").replaceAll("&quot;", "\"")

// This site's _redirects uses literal paths and one-splat paths. Fail on new
// syntax until the checker supports it, rather than silently ignoring a rule.
// https://developers.cloudflare.com/workers/static-assets/redirects/
function readRedirects(root) {
  const path = join(root, "_redirects")
  if (!existsSync(path)) return []
  return readFileSync(path, "utf8").split("\n").flatMap((line, index) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) return []
    const [source, destination, status = "302", extra] = trimmed.split(/\s+/)
    if (
      !source.startsWith("/") || source.startsWith("//") || /[:?#]/.test(source) ||
      source.split("*").length > 2 || !destination?.startsWith("/") ||
      destination.startsWith("//") || !["301", "302", "303", "307", "308"].includes(status) || extra ||
      /:[A-Za-z]/.test(destination.replaceAll(":splat", "")) ||
      (destination.includes(":splat") && !source.includes("*"))
    ) {
      throw new Error(`_redirects:${index + 1}: unsupported redirect: ${trimmed}`)
    }
    const pattern = new RegExp(
      "^" + source.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("(.*)") + "$"
    )
    return [{ source, destination, pattern }]
  })
}

export async function releaseReferences(repoRoot) {
  const { migrationUrl, removedVerbs, removedFlags } = await import(
    pathToFileURL(join(repoRoot, "packages/smithers/src/Unsupported.ts"))
  )
  const { legacyArguments } = await import(
    pathToFileURL(join(repoRoot, "packages/smithers/src/cli/Compatibility.ts"))
  )
  // gen-cli-data reads the actual command tree: canonical verbs override old
  // entries in Unsupported, and other CLI modules emit literal anchors too.
  const removed = JSON.parse(readFileSync(join(repoRoot, "apps/site/src/data/removed-commands.json"), "utf8"))
  if (
    removed.migrationUrl !== migrationUrl || !Array.isArray(removed.anchors) || removed.anchors.length === 0 ||
    removed.anchors.some((anchor) => typeof anchor !== "string" || anchor.length === 0)
  ) {
    throw new Error("Regenerate the CLI removal URL table before building the site")
  }
  const anchors = new Set(removed.anchors)
  // Check new runtime entries even before the generated table is refreshed.
  // The public bin enters Unsupported.refusal only through legacyArguments.
  for (const verb of removedVerbs) {
    if (legacyArguments([verb.name]) !== undefined) anchors.add(verb.name)
  }
  for (const flag of removedFlags) anchors.add(flag.anchor)
  const changelog = readFileSync(join(repoRoot, "CHANGELOG.md"), "utf8")
  const changelogUrls = new Set(
    [...changelog.matchAll(
      /https:\/\/smithers\.sh\/changelogs\/\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?(?:#[0-9A-Za-z_-]+)?/g
    )].map((match) => match[0])
  )
  if (!changelogUrls.size) throw new Error("Cannot find the changelog's site URL")
  return [
    migrationUrl,
    migrationUrl + "/",
    ...[...anchors].map((anchor) => `${migrationUrl}#${anchor}`),
    ...changelogUrls
  ]
}

export function checkBuiltSite(root, requiredReferences = []) {
  const pages = new Map()
  const failures = new Set()
  const redirects = readRedirects(root)
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
  function check(reference, source) {
    let url = new URL(reference, origin)
    if (url.origin !== origin) {
      failures.add(`${source}: required URL leaves the site: ${reference}`)
      return
    }
    const visited = new Set()
    while (true) {
      if (visited.has(url.pathname) || visited.size >= 32) {
        failures.add(`${source}: redirect cycle or excessive chain at ${url.pathname}: ${reference}`)
        return
      }
      visited.add(url.pathname)
      const rule = redirects.find((rule) => rule.pattern.test(url.pathname))
      if (!rule) break
      const match = rule.pattern.exec(url.pathname)
      const destination = new URL(rule.destination.replaceAll(":splat", () => match[1] ?? ""), origin)
      // HTTP redirects without an explicit fragment inherit the original one.
      if (!rule.destination.includes("#")) destination.hash = url.hash
      url = destination
    }
    let target = join(root, decodeURIComponent(url.pathname))
    if (existsSync(target) && statSync(target).isDirectory()) target = join(target, "index.html")
    if (!existsSync(target)) failures.add(`${source}: missing ${reference} (resolved to ${url.pathname})`)
    else if (url.hash && pages.has(target) && !pages.get(target).ids.has(decodeURIComponent(url.hash.slice(1)))) {
      failures.add(`${source}: missing anchor ${reference} (resolved to ${url.pathname}${url.hash})`)
    }
  }
  for (const [page, { references }] of pages) {
    for (const reference of references) {
      if (!reference.startsWith("/") || reference.startsWith("//")) continue
      check(reference, relative(root, page))
    }
  }
  for (const reference of requiredReferences) check(reference, "release URL")
  for (const rule of redirects) {
    if (!rule.source.includes("*")) check(rule.source, "_redirects")
  }
  return { pageCount: pages.size, requiredReferenceCount: requiredReferences.length, failures: [...failures] }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = join(siteRoot, "dist")
  const result = checkBuiltSite(root, await releaseReferences(resolve(siteRoot, "../..")))
  for (const name of ["llms.txt", "llms-full.txt"]) {
    if (
      !existsSync(join(root, name)) ||
      !readFileSync(join(siteRoot, "public", name)).equals(readFileSync(join(root, name)))
    ) {
      result.failures.push(`${name}: built content differs from the current generated source`)
    }
  }
  for (const failure of result.failures) console.error(failure)
  console.log(
    `check-built-site: ${result.pageCount} pages, ${result.requiredReferenceCount} release URLs, ${result.failures.length} failures`
  )
  if (result.failures.length) process.exitCode = 1
}
