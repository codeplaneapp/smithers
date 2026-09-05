/** A loopback registry serving the exact, unpublished first-party tarballs. */
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import { createServer } from "node:http"
import { join } from "node:path"

export const releaseRegistry = async (directory, entries) => {
  const packages = new Map()
  const tarballs = new Map()
  for (const entry of entries) {
    const path = join(directory, entry.filename)
    const manifest = JSON.parse(execFileSync("tar", ["-xOf", path, "package/package.json"], { encoding: "utf8" }))
    if (manifest.name !== entry.name || manifest.version !== entry.version) {
      throw new Error(`Packed identity differs from release manifest: ${entry.filename}`)
    }
    const bytes = await readFile(path)
    packages.set(entry.name, {
      manifest,
      filename: entry.filename,
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`
    })
    tarballs.set(`/tarballs/${entry.filename}`, { path, size: (await stat(path)).size })
  }
  let url
  const server = createServer((request, response) => {
    let pathname
    try {
      pathname = decodeURIComponent(new URL(request.url, url).pathname)
    } catch {
      response.writeHead(400).end()
      return
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405).end()
      return
    }
    const tarball = tarballs.get(pathname)
    if (tarball !== undefined) {
      response.writeHead(200, { "content-type": "application/octet-stream", "content-length": tarball.size })
      if (request.method === "HEAD") response.end()
      else createReadStream(tarball.path).on("error", () => response.destroy()).pipe(response)
      return
    }
    const packed = packages.get(pathname.slice(1))
    if (packed === undefined) {
      response.writeHead(404, { "content-type": "application/json" }).end('{"error":"not_found"}')
      return
    }
    const { manifest, filename, integrity } = packed
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({
      name: manifest.name,
      "dist-tags": { next: manifest.version, latest: manifest.version },
      versions: {
        [manifest.version]: { ...manifest, dist: { tarball: `${url}/tarballs/${filename}`, integrity } }
      }
    }))
  })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  url = `http://127.0.0.1:${server.address().port}`
  return {
    url,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
      server.closeAllConnections()
    })
  }
}
