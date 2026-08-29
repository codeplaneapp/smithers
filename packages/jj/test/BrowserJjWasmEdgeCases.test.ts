/**
 * Edge-case coverage for `BrowserJj` over the REAL `flows_jj.wasm` artifact,
 * complementing `BrowserJjContract.test.ts` (the happy-path contract mirror):
 * empty-repo operations before any snapshot, double init (raw ABI and layer
 * level), snapshot with nothing changed, unicode / deep / space-containing
 * paths, a >1MiB file through the shim's chunked reads, file↔directory
 * replacement across restore, overlapping Effect operations on one instance,
 * and workspaceForget of a name that never existed.
 *
 * Each scenario builds its own temp-dir repo so no test depends on another's
 * mutations. The compiled module is shared — compilation is the expensive
 * part; instantiation per layer is cheap and is itself part of what several
 * tests exercise. When the artifact is absent the suite skips loudly, same as
 * the contract suite.
 */
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import type { PlatformError } from "effect/PlatformError"
import * as fsModule from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import * as BrowserJj from "../src/browser/BrowserJj.ts"
import * as WasiPreview1 from "../src/browser/WasiPreview1.ts"
import { isJjError, Jj, type JjError, type JjFailure } from "../src/Jj.ts"
import { rootedSyncFs } from "./RootedSyncFs.ts"

const wasmPath = fileURLToPath(new URL("../wasm/flows_jj.wasm", import.meta.url))
const wasmBytes: Uint8Array<ArrayBuffer> | undefined = fsModule.existsSync(wasmPath)
  ? new Uint8Array(fsModule.readFileSync(wasmPath))
  : undefined

if (wasmBytes === undefined) {
  // eslint-disable-next-line no-console
  console.warn(
    "[BrowserJjWasmEdgeCases] packages/jj/wasm/flows_jj.wasm is not built — the edge-case "
      + "suite is SKIPPED. Build it with `pnpm --filter @smthrs/jj run build:wasm`."
  )
}

/** The frozen ABI export surface, for the raw double-init exchange. */
interface RawAbi {
  readonly memory: WebAssembly.Memory
  readonly _initialize: () => void
  readonly flows_jj_alloc: (size: number) => number
  readonly flows_jj_free: (ptr: number, size: number) => void
  readonly flows_jj_call: (ptr: number, len: number) => bigint
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

describe.skipIf(wasmBytes === undefined)("BrowserJj edge cases over flows_jj.wasm", () => {
  const timeout = 120_000
  const hosts: Array<string> = []
  let module: WebAssembly.Module

  beforeAll(async () => {
    module = await WebAssembly.compile(wasmBytes!)
  })

  afterAll(() => {
    for (const host of hosts) fsModule.rmSync(host, { recursive: true, force: true })
  })

  /** A fresh host directory containing an empty `repo/` for the WASI namespace. */
  const freshHost = (): string => {
    const host = fsModule.mkdtempSync(join(tmpdir(), "flows-browser-jj-edge-"))
    fsModule.mkdirSync(join(host, "repo"))
    hosts.push(host)
    return host
  }

  const layerFor = (host: string) =>
    BrowserJj.layer({
      wasm: module,
      fs: rootedSyncFs(host),
      root: "/repo",
      onStderr: (text) => {
        // eslint-disable-next-line no-console
        console.error(`[flows_jj.wasm stderr] ${text}`)
      }
    })

  const jjFor = (host: string) => Effect.provide(Jj, layerFor(host))

  const write = (host: string, path: string, content: string | Uint8Array): void => {
    const target = join(host, "repo", path)
    fsModule.mkdirSync(dirname(target), { recursive: true })
    fsModule.writeFileSync(target, content)
  }

  const read = (host: string, path: string): string => fsModule.readFileSync(join(host, "repo", path), "utf8")

  /**
   * `Jj`'s error channel also carries the capability kernel's failures, which
   * an undecorated host layer can never produce — narrow instead of widening
   * every assertion.
   */
  const flip = (effect: Effect.Effect<unknown, JjFailure | PlatformError>) =>
    Effect.map(Effect.flip(effect), (error) => {
      if (!isJjError(error)) throw new Error(`expected a JjError, got ${error._tag}`)
      return error
    })

  describe("empty repo (before any snapshot)", () => {
    it.effect("status auto-initializes the repo and reports a clean working copy", () =>
      Effect.gen(function*() {
        const host = freshHost()
        const jj = yield* jjFor(host)
        const status = yield* (jj.status())
        expect(status).toContain("The working copy has no changes.")
        expect(status).toMatch(/Working copy {2}\(@\) : [k-z]{12}/)
        expect(fsModule.existsSync(join(host, "repo", ".jj"))).toBe(true)
      }), { timeout })

    it.effect("diff of @ against @ is empty and restore from @ is a no-op", () =>
      Effect.gen(function*() {
        const host = freshHost()
        const jj = yield* jjFor(host)
        expect(yield* (jj.diff("@", "@"))).toBe("")
        yield* (jj.restore("@"))
      }), { timeout })

    it.effect(
      "restore and diff of unknown or empty revisions fail invalid_ref, not crash",
      () =>
        Effect.gen(function*() {
          const host = freshHost()
          const jj = yield* jjFor(host)
          // Well-formed reverse-hex id that matches nothing in a fresh repo.
          const restoreError = yield* flip(jj.restore("kkkkkkkkkkkk"))
          expect(restoreError.code).toBe("invalid_ref")
          const emptyRev = yield* flip(jj.diff("", ""))
          expect(emptyRev.code).toBe("invalid_ref")
          // The instance stays usable after the failures.
          const { changeId } = yield* (jj.snapshot("still alive"))
          expect(changeId).toMatch(/^[k-z]{12}$/)
        }),
      { timeout }
    )

    it.effect("snapshot works on a repo with no files at all", () =>
      Effect.gen(function*() {
        const host = freshHost()
        const jj = yield* jjFor(host)
        const { changeId } = yield* (jj.snapshot("nothing yet"))
        expect(changeId).toMatch(/^[k-z]{12}$/)
      }), { timeout })
  })

  describe("double init", () => {
    it("raw ABI init is idempotent: a second init answers ok and resets nothing", { timeout }, async () => {
      const host = freshHost()
      const wasi = WasiPreview1.make({ fs: rootedSyncFs(host) })
      const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: { ...wasi.imports } })
      const abi = instance.exports as unknown as RawAbi
      wasi.initialize(abi.memory)
      abi._initialize()

      const exchange = (request: Record<string, unknown>): unknown => {
        const req = encoder.encode(JSON.stringify(request))
        const reqPtr = abi.flows_jj_alloc(req.length)
        new Uint8Array(abi.memory.buffer, reqPtr, req.length).set(req)
        const packed = BigInt.asUintN(64, abi.flows_jj_call(reqPtr, req.length))
        const resPtr = Number(packed >> 32n)
        const resLen = Number(packed & 0xFFFF_FFFFn)
        const response = new Uint8Array(abi.memory.buffer, resPtr, resLen).slice()
        abi.flows_jj_free(resPtr, resLen)
        abi.flows_jj_free(reqPtr, req.length)
        return JSON.parse(decoder.decode(response))
      }

      expect(exchange({ op: "init", root: "/repo" })).toEqual({ ok: {} })
      expect(fsModule.existsSync(join(host, "repo", ".jj"))).toBe(true)

      write(host, "kept.txt", "kept\n")
      expect(exchange({ op: "init", root: "/repo" })).toEqual({ ok: {} })
      expect(read(host, "kept.txt")).toBe("kept\n")
    })

    it.effect("a second instance over a just-initialized empty repo loads it", () =>
      Effect.gen(function*() {
        const host = freshHost()
        const first = yield* jjFor(host)
        yield* (first.status()) // auto-init with zero snapshots
        const second = yield* jjFor(host)
        const status = yield* (second.status())
        expect(status).toContain("The working copy has no changes.")
      }), { timeout })
  })

  describe("snapshot with no changes", () => {
    it.effect("closes the (empty) current change and opens another with a distinct id", () =>
      Effect.gen(function*() {
        const host = freshHost()
        const jj = yield* jjFor(host)
        write(host, "a.txt", "alpha\n")
        const { changeId: first } = yield* (jj.snapshot("has a file"))
        // Nothing changed since: the snapshot still succeeds and moves on.
        const { changeId: second } = yield* (jj.snapshot())
        expect(second).toMatch(/^[k-z]{12}$/)
        expect(second).not.toBe(first)
        // Both are restorable states carrying the same tree.
        expect(yield* (jj.diff(first, second))).toBe("")
        yield* (jj.restore(first))
        expect(read(host, "a.txt")).toBe("alpha\n")
      }), { timeout })
  })

  describe("paths: unicode, deep nesting, spaces", () => {
    const spaced = "dir with spaces/spaced file.txt"
    const deep = "a/b/c/d/e/f/g/deep.txt"
    const unicode = "ünïcödé-文件-\u{1F680}.txt"

    it.effect("snapshots, diffs, and restores files at awkward paths", () =>
      Effect.gen(function*() {
        const host = freshHost()
        const jj = yield* jjFor(host)
        write(host, spaced, "spaced v1\n")
        write(host, deep, "deep v1\n")
        write(host, unicode, "unicode v1\n")
        const { changeId: s1 } = yield* (jj.snapshot("awkward paths"))

        write(host, unicode, "unicode v2\n")
        fsModule.unlinkSync(join(host, "repo", spaced))
        const status = yield* (jj.status())
        expect(status).toContain(`D ${spaced}`)
        expect(status).toContain(`M ${unicode}`)

        const { changeId: s2 } = yield* (jj.snapshot("mutated"))
        const diff = yield* (jj.diff(s1, s2))
        expect(diff).toContain(`diff --git a/${unicode} b/${unicode}`)
        expect(diff).toContain("-unicode v1")
        expect(diff).toContain("+unicode v2")
        expect(diff).toContain(`deleted file mode 100644`)
        expect(diff).toContain(`--- a/${spaced}`)

        yield* (jj.restore(s1))
        expect(read(host, spaced)).toBe("spaced v1\n")
        expect(read(host, deep)).toBe("deep v1\n")
        expect(read(host, unicode)).toBe("unicode v1\n")

        yield* (jj.restore(s2))
        expect(fsModule.existsSync(join(host, "repo", spaced))).toBe(false)
        expect(read(host, unicode)).toBe("unicode v2\n")
      }), { timeout })
  })

  describe("large file through the shim's chunked reads", () => {
    it.effect("roundtrips a >1MiB file byte-for-byte across snapshot and restore", () =>
      Effect.gen(function*() {
        const host = freshHost()
        const jj = yield* jjFor(host)
        // ~2MiB of distinct ASCII lines: big enough to force many fd_read /
        // fd_write iterations, text so the diff path stays exact.
        let base = ""
        for (let i = 0; base.length < 2 * 1024 * 1024; i++) {
          base += `line ${i} abcdefghijklmnopqrstuvwxyz 0123456789\n`
        }
        write(host, "big.txt", base)
        const { changeId: s1 } = yield* (jj.snapshot("big v1"))

        const extended = base + "tail-marker\n"
        write(host, "big.txt", extended)
        const { changeId: s2 } = yield* (jj.snapshot("big v2"))

        const diff = yield* (jj.diff(s1, s2))
        expect(diff).toContain("+tail-marker")
        expect(diff).not.toContain("-line 0 ")

        write(host, "big.txt", "scribbled over\n")
        yield* (jj.restore(s1))
        expect(read(host, "big.txt")).toBe(base)

        yield* (jj.restore(s2))
        expect(read(host, "big.txt")).toBe(extended)
      }), { timeout })
  })

  describe("file/directory replacement across restore", () => {
    it.effect("restores a path back and forth between file and directory", () =>
      Effect.gen(function*() {
        const host = freshHost()
        const jj = yield* jjFor(host)
        write(host, "thing", "i am a file\n")
        const { changeId: fileState } = yield* (jj.snapshot("thing is a file"))

        fsModule.unlinkSync(join(host, "repo", "thing"))
        write(host, "thing/inner.txt", "i am inside\n")
        const { changeId: dirState } = yield* (jj.snapshot("thing is a directory"))
        expect(fsModule.statSync(join(host, "repo", "thing")).isDirectory()).toBe(true)

        yield* (jj.restore(fileState))
        expect(fsModule.statSync(join(host, "repo", "thing")).isFile()).toBe(true)
        expect(read(host, "thing")).toBe("i am a file\n")

        yield* (jj.restore(dirState))
        expect(fsModule.statSync(join(host, "repo", "thing")).isDirectory()).toBe(true)
        expect(read(host, "thing/inner.txt")).toBe("i am inside\n")
      }), { timeout })
  })

  describe("symlinks in the working copy", () => {
    // KNOWN DIVERGENCE from NodeJj, pinned deliberately: jj-lib on
    // wasm32-wasip1 reports symlinks unsupported (`check_symlink_support()` in
    // vendor/jj lib/src/file_util.rs `cfg(target_os = "wasi")`), the same
    // posture as jj on Windows without developer mode. Checkout therefore
    // materializes tree symlinks as regular "fake symlink" files, and — more
    // surprisingly — snapshotting a REAL on-disk symlink (which the browser
    // slice can create) stores the linked file's CONTENT as the symlink
    // target, because `write_symlink_to_store` reads the path with `fs::read`,
    // which follows the link. The shim's `path_symlink`/`path_readlink` are
    // wired and unit-tested but jj-lib never issues them on wasi. If a jj bump
    // changes any of this, this test failing is the signal to re-read it.
    it.effect("degrades a real symlink to a regular file carrying the target's content", () =>
      Effect.gen(function*() {
        const host = freshHost()
        const jj = yield* jjFor(host)
        write(host, "target.txt", "the target\n")
        fsModule.symlinkSync("target.txt", join(host, "repo", "link"))
        const { changeId: withLink } = yield* (jj.snapshot("with symlink"))

        fsModule.unlinkSync(join(host, "repo", "link"))
        const { changeId: without } = yield* (jj.snapshot("link removed"))

        // The tree entry is a symlink (mode 120000) whose target is the linked
        // file's content — followed at snapshot time, not read as a link.
        const diff = yield* (jj.diff(without, withLink))
        expect(diff).toContain("new file mode 120000")
        expect(diff).toContain("+the target")

        // Restore materializes the fake-symlink form: a plain file, no link.
        yield* (jj.restore(withLink))
        const restored = fsModule.lstatSync(join(host, "repo", "link"))
        expect(restored.isSymbolicLink()).toBe(false)
        expect(restored.isFile()).toBe(true)
        expect(read(host, "link")).toBe("the target\n")

        // The degraded representation is stable: re-snapshotting the fake
        // symlink reproduces the identical tree entry, so state cannot drift
        // across further snapshot/restore cycles.
        const { changeId: resnap } = yield* (jj.snapshot("resnap"))
        expect(yield* (jj.diff(withLink, resnap))).toBe("")

        yield* (jj.restore(without))
        expect(fsModule.existsSync(join(host, "repo", "link"))).toBe(false)
      }), { timeout })
  })

  describe("concurrent operations on one instance", () => {
    it.effect("overlapping first operations instantiate once and serialize cleanly", () =>
      Effect.gen(function*() {
        const host = freshHost()
        const jj = yield* jjFor(host)
        write(host, "x.txt", "x\n")
        write(host, "y.txt", "y\n")
        // Both fibers race the lazy instantiation and then the wasm call itself.
        const [snap, status] = yield* (
          Effect.all([jj.snapshot("from fiber one"), jj.status()], { concurrency: "unbounded" })
        )
        expect(snap.changeId).toMatch(/^[k-z]{12}$/)
        expect(status.length).toBeGreaterThan(0)
        // The repo is consistent afterwards: the snapshot resolves and restores.
        write(host, "x.txt", "mutated\n")
        yield* (jj.restore(snap.changeId))
        expect(read(host, "x.txt")).toBe("x\n")
      }), { timeout })
  })

  describe("workspaceForget of a nonexistent name", () => {
    it.effect("is a no-op like the CLI, and stays a no-op after a real forget", () =>
      Effect.gen(function*() {
        const host = freshHost()
        const jj = yield* jjFor(host)
        write(host, "a.txt", "alpha\n")
        yield* (jj.snapshot("base"))

        yield* (jj.workspaceForget("never-existed"))

        yield* (jj.workspaceAdd("lane", "/lane1"))
        expect(fsModule.existsSync(join(host, "lane1"))).toBe(true)
        const duplicate = yield* flip(jj.workspaceAdd("lane", "/lane2"))
        expect(duplicate.code).toBe("unknown")
        expect(duplicate.message).toContain("already exists")

        yield* (jj.workspaceForget("lane"))
        // Forgetting the same name again: gone means gone, still ok.
        yield* (jj.workspaceForget("lane"))
      }), { timeout })
  })
})
