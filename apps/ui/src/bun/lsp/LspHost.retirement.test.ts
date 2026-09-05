import { afterEach, expect, test } from "bun:test"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { currentSandboxHost } from "../Sandbox"
import { createLspHost } from "./LspHost"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop() })

const retiringHost = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "smithers-lsp-retirement-")))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const script = join(root, "server.mjs")
  await writeFile(join(root, "a.ts"), "const a = 1\n")
  // A real stdio process holds shutdown open so ownership can be observed
  // independently of TypeScript's cold-project load or scheduler timing.
  await writeFile(script, `let b=Buffer.alloc(0);function send(m){const p=Buffer.from(JSON.stringify({jsonrpc:'2.0',...m}));process.stdout.write('Content-Length: '+p.length+'\\r\\n\\r\\n');process.stdout.write(p)}
process.stdin.on('data',chunk=>{b=Buffer.concat([b,chunk]);for(;;){const h=b.indexOf('\\r\\n\\r\\n');if(h<0)return;const n=Number(/Content-Length: (\\d+)/i.exec(b.subarray(0,h).toString())[1]);if(b.length<h+4+n)return;const m=JSON.parse(b.subarray(h+4,h+4+n));b=b.subarray(h+4+n);if(m.method==='initialize')send({id:m.id,result:{capabilities:{}}});if(m.method==='textDocument/hover')send({id:m.id,result:{contents:'number'}});if(m.method==='shutdown')setTimeout(()=>send({id:m.id,result:null}),150);if(m.method==='exit')setTimeout(()=>process.exit(0),20)}})`)
  let retire!: () => void
  const retiring = new Promise<void>((resolve) => { retire = resolve })
  const host = createLspHost({
    publish: () => {}, node: Promise.resolve({ path: process.execPath, version: "22.19.0" }),
    home: root, sandbox: currentSandboxHost(), idleMs: 30, requestTimeoutMs: 2000,
    lookup: { env: { PATH: root }, home: root, listDir: () => [], isFile: (path) => path === join(root, "typescript-language-server"), realpath: () => script },
    log: (line) => { if (line.includes("shutting down (idle)")) retire() }
  })
  cleanup.push(() => host.killAll())
  const first = await host.session("repo", root, "a.ts")
  if (first.status !== "ok") throw new Error(first.status)
  await first.session.hover("a.ts", { line: 1, character: 1 })
  await retiring
  return { root, host, first: first.session }
}

test("an idle LSP remains owned until shutdown completes, including killAll", async () => {
  const { host, first } = await retiringHost()
  expect(host.list()).toHaveLength(1)
  let stopped = false
  const stopping = host.killAll().then(() => { stopped = true })
  await Bun.sleep(20)
  expect(stopped).toBe(false)
  await stopping
  expect(first.state).toBe("exited")
  expect(host.list()).toEqual([])
})

test("a new request waits for an idle LSP to exit before replacing it", async () => {
  const { root, host, first } = await retiringHost()
  let opened = false
  const opening = host.session("repo", root, "a.ts").then((result) => { opened = true; return result })
  await Bun.sleep(20)
  expect(opened).toBe(false)
  const next = await opening
  if (next.status !== "ok") throw new Error(next.status)
  expect(first.state).toBe("exited")
  expect(next.session.pid).not.toBe(first.pid)
  await next.session.hover("a.ts", { line: 1, character: 1 })
})
