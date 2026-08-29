/*
 * The Electrobun main process (LOCAL-APP.md, "Runtime topology"). The only
 * file that imports the Electrobun SDK: it starts the local origin, then
 * opens one window at it. The origin is the only transport between the SPA
 * and this process; RPC carries just the two native doors (the folder dialog
 * and the system browser), and both have HTTP fallbacks.
 */
import { BrowserView, BrowserWindow, Utils } from "electrobun/main"
import type { SmithersNativeRPC } from "smithers-shared/NativeRPC"
import { inspectLocalRepository } from "./LocalRepository"
import { defaultDistDir, startLocalServer } from "./server"

const headless = Bun.env.SMITHERS_LOCAL_HEADLESS === "1"
const port = Number(Bun.env.SMITHERS_LOCAL_PORT ?? "0")

/** http(s) only: the page must not launch arbitrary local schemes through the privileged side. */
const openExternal = async (url: string): Promise<boolean> => {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false
  return Utils.openExternal(parsed.toString())
}

const server = await startLocalServer({
  port: Number.isInteger(port) && port >= 0 ? port : 0,
  distDir: defaultDistDir(import.meta.dir),
  chatStub: Bun.env.SMITHERS_CHAT_STUB === "1",
  openExternal
})

if (headless) {
  console.log("SMITHERS_LOCAL_HEADLESS=1: serving without a window")
} else {
  const rpc = BrowserView.defineRPC<SmithersNativeRPC>({
    handlers: {
      requests: {
        pickLocalRepository: async ({ access }) => {
          const selectedPaths = await Utils.openFileDialog({
            canChooseFiles: false,
            canChooseDirectory: true,
            allowsMultipleSelection: false
          })
          const selectedPath = selectedPaths.find((path) => path.trim() !== "")
          if (selectedPath === undefined) return { status: "cancelled" } as const
          return inspectLocalRepository(selectedPath, access)
        },
        openExternal: async ({ url }) => ({ opened: await openExternal(url) })
      },
      messages: {}
    }
  })

  // The local origin, never views:// and never a Vite dev server.
  new BrowserWindow({
    title: "Smithers",
    url: `${server.origin}/`,
    rpc,
    frame: {
      width: 1180,
      height: 800,
      x: 100,
      y: 60
    }
  })
}

console.log("Smithers app started!")
