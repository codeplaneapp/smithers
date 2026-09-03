/**
 * The sandbox contract, platform by platform, without spawning anything.
 *
 * Every mechanism's argv is built from a plan and a fake host, so the Linux
 * argv is checked on macOS and the seatbelt profile on Linux. Real enforcement
 * is proven end to end in `@smthrs/build-cli`'s sandbox suites, which run the
 * host's own mechanism.
 */
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as ExecSandbox from "../src/ExecSandbox.ts"
import { Sandbox } from "../src/WorkspaceDeclaration.ts"

const root = "/work/ws"

const host = (
  platform: NodeJS.Platform,
  executables: Readonly<Record<string, string>> = {},
  existing: ReadonlyArray<string> = [],
  directories: ReadonlyArray<string> = []
): ExecSandbox.Host => ({
  platform,
  executable: (name) => executables[name],
  exists: (path) => existing.includes(path) || directories.includes(path),
  isDirectory: (path) => directories.includes(path),
  uid: 501,
  gid: 20
})

const linux = host("linux", { bwrap: "/usr/bin/bwrap" }, ["/work/ws/src/a.ts"], [
  "/work/ws/node_modules",
  "/work/ws/dist"
])
const darwin = host("darwin", { "/usr/bin/sandbox-exec": "/usr/bin/sandbox-exec" }, ["/work/ws/src/a.ts"], [
  "/work/ws/node_modules",
  "/work/ws/dist"
])
const windows = host("win32", { docker: "C:\\docker.exe" })

const request: ExecSandbox.Request = {
  policy: {},
  reads: ["src/a.ts", "node_modules", "missing.txt", "../outside"],
  writes: ["dist", "out/bundle.js"],
  readOnly: [".flows/cache"]
}

const planned = (hostFacts: ExecSandbox.Host, override: Partial<ExecSandbox.Request> = {}): ExecSandbox.Plan => {
  const plan = ExecSandbox.plan(
    { ...request, ...override },
    { workspaceRoot: root, cwd: `${root}/pkg`, tmp: "/work/ws/.flows/sandbox/run1" },
    hostFacts
  )
  if (plan === undefined || ExecSandbox.isUnenforceable(plan)) throw new Error("expected a plan")
  return plan
}

describe("network", () => {
  it("resolves the policy to a posture and lets services open loopback only", () => {
    expect(ExecSandbox.network(undefined)).toBe("none")
    expect(ExecSandbox.network({})).toBe("none")
    expect(ExecSandbox.network({ network: false })).toBe("none")
    expect(ExecSandbox.network({ network: "loopback" })).toBe("loopback")
    expect(ExecSandbox.network({ network: true })).toBe("open")
    expect(ExecSandbox.network("none")).toBe("open")
    expect(ExecSandbox.network(undefined, true)).toBe("loopback")
    expect(ExecSandbox.network({ network: true }, true)).toBe("open")
  })
})

describe("selection", () => {
  it("picks the platform mechanism when nothing is declared", () => {
    expect(ExecSandbox.select(request, linux)).toEqual({ _tag: "bubblewrap", executable: "/usr/bin/bwrap" })
    expect(ExecSandbox.select(request, darwin)).toEqual({ _tag: "seatbelt", executable: "/usr/bin/sandbox-exec" })
  })

  it("selects nothing for the explicit opt-outs", () => {
    expect(ExecSandbox.select({ ...request, policy: "none" }, linux)).toEqual({ _tag: "none" })
    expect(ExecSandbox.select({ ...request, mechanism: Sandbox.None() }, linux)).toEqual({ _tag: "none" })
    expect(ExecSandbox.enforceable({ ...request, policy: "none" }, linux)).toBe(false)
  })

  it("refuses a Linux host without bwrap instead of running unconfined", () => {
    const selected = ExecSandbox.select(request, host("linux"))
    expect(ExecSandbox.isUnenforceable(selected)).toBe(true)
    if (!ExecSandbox.isUnenforceable(selected)) return
    expect(selected.missing).toBe("bwrap")
    expect(selected.message).toContain("bubblewrap")
    expect(selected.message).toContain("never runs unconfined")
    expect(ExecSandbox.enforceable(request, host("linux"))).toBe(false)
  })

  it("refuses Windows without a docker declaration and honors one with docker on PATH", () => {
    const bare = ExecSandbox.select(request, host("win32"))
    expect(ExecSandbox.isUnenforceable(bare)).toBe(true)
    if (ExecSandbox.isUnenforceable(bare)) expect(bare.missing).toBe("S.Sandbox.Docker")
    const declared = ExecSandbox.select({ ...request, mechanism: Sandbox.Docker({ image: "node:22" }) }, windows)
    expect(declared).toEqual({ _tag: "docker", executable: "C:\\docker.exe", image: "node:22" })
    const missing = ExecSandbox.select({ ...request, mechanism: Sandbox.Docker({ image: "node:22" }) }, host("win32"))
    expect(ExecSandbox.isUnenforceable(missing)).toBe(true)
    if (ExecSandbox.isUnenforceable(missing)) expect(missing.missing).toBe("docker")
  })

  it("refuses a bubblewrap declaration off Linux", () => {
    const selected = ExecSandbox.select({ ...request, mechanism: Sandbox.Bubblewrap() }, darwin)
    expect(ExecSandbox.isUnenforceable(selected)).toBe(true)
    if (ExecSandbox.isUnenforceable(selected)) expect(selected.mechanism).toBe("bubblewrap")
  })

  it("refuses macOS when the system seatbelt executable is missing", () => {
    const selected = ExecSandbox.select(request, host("darwin"))
    expect(ExecSandbox.isUnenforceable(selected)).toBe(true)
    if (ExecSandbox.isUnenforceable(selected)) expect(selected.missing).toBe("/usr/bin/sandbox-exec")
  })
})

describe("plan", () => {
  it("anchors paths at the root, drops escapes and missing reads, and opens a file output's directory", () => {
    const plan = planned(linux)
    expect(plan.reads).toEqual(["/work/ws/src/a.ts", "/work/ws/node_modules"])
    expect(plan.writes).toEqual(["/work/ws/out", "/work/ws/dist"])
    expect(plan.readOnly).toEqual(["/work/ws/.flows/cache"])
    expect(plan.network).toBe("none")
    expect(plan.cwd).toBe("/work/ws/pkg")
  })

  it("collapses a path covered by a broader entry", () => {
    const plan = planned(
      host("linux", { bwrap: "/usr/bin/bwrap" }, ["/work/ws/src/a.ts", "/work/ws/src/b.ts"], [
        "/work/ws/src"
      ]),
      { reads: ["src", "src/a.ts", "src/b.ts"] }
    )
    expect(plan.reads).toEqual(["/work/ws/src"])
  })

  it("records where a read that links out of the workspace really lives, and nothing for the rest", () => {
    const linked: ExecSandbox.Host = {
      ...linux,
      realpath: (path) => path === "/work/ws/node_modules" ? "/tmp/real-ws/node_modules" : path
    }
    expect(planned(linked).externalReads).toEqual(["/tmp/real-ws/node_modules"])
    expect(planned(linux).externalReads).toEqual([])
    const inside: ExecSandbox.Host = {
      ...linux,
      realpath: (path) => path === "/work/ws/node_modules" ? "/work/ws/.store/node_modules" : path
    }
    expect(planned(inside).externalReads).toEqual([])
  })

  it("admits a requested external read only when it is absolute, outside the root, and present", () => {
    const present = host("linux", { bwrap: "/usr/bin/bwrap" }, ["/work/ws/src/a.ts", "/srv/git/one"], [
      "/work/ws/node_modules"
    ])
    const plan = planned(present, {
      externalReads: ["/srv/git/one", "/srv/git/missing", "/work/ws/src/a.ts", "relative/path"]
    })
    expect(plan.externalReads).toEqual(["/srv/git/one"])
  })

  it("returns nothing for an opted-out policy and the refusal for an unenforceable host", () => {
    expect(
      ExecSandbox.plan({ ...request, policy: "none" }, { workspaceRoot: root, cwd: root, tmp: "/t" }, linux)
    ).toBeUndefined()
    const refused = ExecSandbox.plan(request, { workspaceRoot: root, cwd: root, tmp: "/t" }, host("linux"))
    expect(ExecSandbox.isUnenforceable(refused)).toBe(true)
  })
})

describe("bubblewrap argv", () => {
  it("binds the root read-only, shadows the workspace, binds the declared set, and remounts read-only last", () => {
    const argv = ExecSandbox.bubblewrap(planned(linux), ["node", "build.js"])
    const text = argv.join(" ")
    expect(argv[0]).toBe("/usr/bin/bwrap")
    expect(text).toContain("--ro-bind / /")
    expect(text).toContain("--tmpfs /work/ws")
    expect(text).toContain("--ro-bind /work/ws/src/a.ts /work/ws/src/a.ts")
    expect(text).toContain("--bind /work/ws/dist /work/ws/dist")
    expect(text).toContain("--remount-ro /work/ws")
    expect(text).toContain("--unshare-all")
    expect(text).not.toContain("--share-net")
    expect(text).toContain("--chdir /work/ws/pkg")
    expect(argv.slice(-2)).toEqual(["node", "build.js"])
    expect(argv.indexOf("--remount-ro")).toBeGreaterThan(argv.lastIndexOf("--bind"))
  })

  it("binds a linked read's real location before the link itself", () => {
    const linked: ExecSandbox.Host = {
      ...linux,
      realpath: (path) => path === "/work/ws/node_modules" ? "/tmp/real-ws/node_modules" : path
    }
    const argv = ExecSandbox.bubblewrap(planned(linked), ["node", "build.js"])
    const text = argv.join(" ")
    expect(text).toContain("--ro-bind /tmp/real-ws/node_modules /tmp/real-ws/node_modules")
    expect(text).toContain("--ro-bind /work/ws/node_modules /work/ws/node_modules")
    expect(argv.indexOf("/tmp/real-ws/node_modules")).toBeLessThan(argv.indexOf("/work/ws/node_modules"))
    expect(argv.indexOf("/tmp/real-ws/node_modules")).toBeGreaterThan(argv.indexOf("/tmp"))
  })

  it("re-closes a read-only subtree under a writable directory", () => {
    const argv = ExecSandbox.bubblewrap(
      planned(host("linux", { bwrap: "/usr/bin/bwrap" }, [], ["/work/ws/.flows"]), {
        writes: [".flows"],
        readOnly: [".flows/cache"]
      }),
      ["true"]
    )
    const text = argv.join(" ")
    expect(text).toContain("--bind /work/ws/.flows /work/ws/.flows")
    expect(text).toContain("--ro-bind-try /work/ws/.flows/cache /work/ws/.flows/cache")
    expect(text.indexOf("--ro-bind-try")).toBeGreaterThan(text.indexOf("--bind /work/ws/.flows "))
  })

  it("does not remount the root read-only when the root itself is the declared write directory", () => {
    // A declared output file at the top level opens its parent, the root.
    const rootWrite = planned(host("linux", { bwrap: "/usr/bin/bwrap" }, [], ["/work/ws"]), {
      reads: [],
      writes: ["out.txt"],
      readOnly: []
    })
    expect(rootWrite.writes).toEqual(["/work/ws"])
    const argv = ExecSandbox.bubblewrap(rootWrite, ["true"])
    const text = argv.join(" ")
    expect(text).toContain("--bind /work/ws /work/ws")
    expect(text).not.toContain("--remount-ro")
    // A write below the root keeps the tmpfs at the root re-closed.
    const nested = ExecSandbox.bubblewrap(planned(linux), ["true"]).join(" ")
    expect(nested).toContain("--remount-ro /work/ws")
  })

  it("unshares the network for the default policy and shares the host's for loopback and open", () => {
    const open = ExecSandbox.bubblewrap(planned(linux, { policy: { network: true } }), ["true"]).join(" ")
    expect(open).toContain("--share-net")
    const loopback = ExecSandbox.bubblewrap(planned(linux, { policy: { network: "loopback" } }), ["true"])
    expect(loopback.join(" ")).toContain("--share-net")
    expect(loopback.slice(-2)).toEqual(["--", "true"])
    const services = ExecSandbox.bubblewrap(planned(linux, { services: true }), ["true"]).join(" ")
    expect(services).toContain("--share-net")
  })
})

describe("folding declared files into directories", () => {
  const listing: Readonly<Record<string, ReadonlyArray<string>>> = {
    "/work/ws": ["src", "node_modules", "package.json"],
    "/work/ws/src": ["lib", "c.ts", "d.ts", "__generated__"],
    "/work/ws/src/lib": ["a.ts", "b.ts", "deep"],
    "/work/ws/src/lib/deep": ["e.ts"],
    "/work/ws/src/__generated__": ["x.graphql.ts"]
  }
  const files = ["/work/ws/src/lib/a.ts", "/work/ws/src/lib/b.ts", "/work/ws/src/lib/deep/e.ts", "/work/ws/src/c.ts"]
  const listingHost: ExecSandbox.Host = {
    ...host(
      "darwin",
      { "/usr/bin/sandbox-exec": "/usr/bin/sandbox-exec" },
      [...files, "/work/ws/package.json"],
      Object.keys(listing)
    ),
    entries: (directory) => listing[directory]
  }
  const reads = ["src/lib/a.ts", "src/lib/b.ts", "src/lib/deep/e.ts", "src/c.ts"]

  it("grants a mostly declared subtree whole and re-closes what the declaration left out", () => {
    const plan = planned(listingHost, { reads, writes: [] })
    expect(plan.reads).toEqual(["/work/ws/src"])
    expect(plan.readDenies).toEqual(["/work/ws/src/d.ts", "/work/ws/src/__generated__"])
    const profile = ExecSandbox.seatbelt(plan)
    const grant = profile.indexOf("(subpath \"/work/ws/src\")")
    const close = profile.indexOf(
      "(deny file-read* (subpath \"/work/ws/src/d.ts\") (subpath \"/work/ws/src/__generated__\"))"
    )
    expect(grant).toBeGreaterThan(0)
    expect(close).toBeGreaterThan(grant)
    expect(profile).not.toContain("a.ts")
  })

  it("counts a declared write as covered, never folds the root, and keeps every file when the host cannot list", () => {
    const withWrite = planned(listingHost, { reads, writes: ["src/__generated__"] })
    expect(withWrite.reads).toEqual(["/work/ws/src"])
    expect(withWrite.readDenies).toEqual(["/work/ws/src/d.ts"])
    const rootOnly = planned(listingHost, { reads: ["package.json"], writes: [] })
    expect(rootOnly.reads).toEqual(["/work/ws/package.json"])
    expect(rootOnly.readDenies).toEqual([])
    const blind = planned({ ...listingHost, entries: undefined }, { reads, writes: [] })
    expect([...blind.reads].sort()).toEqual([...files].sort())
    expect(blind.readDenies).toEqual([])
  })

  it("leaves a directory alone when an uncovered entry still holds declared files below it", () => {
    const sparse: ExecSandbox.Host = {
      ...listingHost,
      entries: (
        directory
      ) => (directory === "/work/ws/src/lib" ? ["a.ts", "b.ts", "deep", "n1", "n2", "n3", "n4"] : listing[directory])
    }
    const plan = planned(sparse, { reads, writes: [] })
    // lib: three covered entries (a, b, and the folded deep) against four uncovered ones: not folded.
    expect(plan.reads).not.toContain("/work/ws/src/lib")
    expect(plan.reads).not.toContain("/work/ws/src")
    expect(plan.reads).toContain("/work/ws/src/lib/deep")
  })

  it("does not fold for bubblewrap, which binds each declared path", () => {
    const linuxListing: ExecSandbox.Host = { ...listingHost, platform: "linux", executable: () => "/usr/bin/bwrap" }
    const plan = planned(linuxListing, { reads, writes: [] })
    expect([...plan.reads].sort()).toEqual([...files].sort())
    expect(plan.readDenies).toEqual([])
  })
})

describe("seatbelt profile", () => {
  it("denies network and writes, closes reads under the workspace, and reopens the declared set", () => {
    const profile = ExecSandbox.seatbelt(planned(darwin))
    expect(profile.startsWith("(version 1)(allow default)")).toBe(true)
    expect(profile).toContain("(deny network*)")
    expect(profile).toContain("(deny file-write*)")
    expect(profile).toContain(
      "(allow file-write* (subpath \"/dev\") (subpath \"/work/ws/out\") (subpath \"/work/ws/dist\") (subpath \"/work/ws/.flows/sandbox/run1\"))"
    )
    expect(profile).toContain("(deny file-write* (subpath \"/work/ws/.flows/cache\"))")
    expect(profile).toContain("(deny file-read* (subpath \"/work/ws\"))")
    expect(profile).toContain("(allow file-read-metadata (subpath \"/work/ws\"))")
    expect(profile).toContain("(literal \"/work/ws\")")
    expect(profile).toContain("(literal \"/work/ws/src\")")
    expect(profile).toContain("(subpath \"/work/ws/src/a.ts\")")
    expect(profile).toContain("(subpath \"/work/ws/node_modules\")")
    expect(profile).not.toContain("localhost")
  })

  it("opens loopback and the whole network in steps", () => {
    const loopback = ExecSandbox.seatbelt(planned(darwin, { policy: { network: "loopback" } }))
    expect(loopback).toContain("(deny network*)")
    expect(loopback).toContain("(allow network-bind (local ip \"localhost:*\"))")
    const open = ExecSandbox.seatbelt(planned(darwin, { policy: { network: true } }))
    expect(open).not.toContain("(deny network*)")
  })

  it("escapes quotes and backslashes in paths", () => {
    const plan = planned(
      host("darwin", { "/usr/bin/sandbox-exec": "/usr/bin/sandbox-exec" }, [], ["/work/ws/we\"ird"]),
      {
        reads: ["we\"ird"],
        writes: []
      }
    )
    expect(ExecSandbox.seatbelt(plan)).toContain("(subpath \"/work/ws/we\\\"ird\")")
  })
})

describe("docker argv", () => {
  it("mounts an external read at its host path, read-only", () => {
    const plan = planned(
      host("win32", { docker: "docker" }, ["/work/ws/src/a.ts", "/srv/git/one"], ["/work/ws/node_modules"]),
      { mechanism: Sandbox.Docker({ image: "node:22" }), externalReads: ["/srv/git/one"] }
    )
    const text = ExecSandbox.docker(plan, ["node"], {}).join(" ")
    expect(text).toContain("--mount type=bind,src=/srv/git/one,dst=/srv/git/one,readonly")
  })

  it("mounts the declared set at its host paths, closes the network, and maps the user", () => {
    const plan = planned(
      host("win32", { docker: "docker" }, ["/work/ws/src/a.ts"], ["/work/ws/node_modules", "/work/ws/dist"]),
      {
        mechanism: Sandbox.Docker({ image: "node:22" })
      }
    )
    const argv = ExecSandbox.docker(plan, ["node", "build.js"], { PATH: "/ignored", HOME: "/ignored", CI: "1" })
    const text = argv.join(" ")
    expect(argv.slice(0, 3)).toEqual(["docker", "run", "--rm"])
    expect(text).toContain("--read-only")
    expect(text).toContain("--network none")
    expect(text).toContain("--workdir /work/ws/pkg")
    expect(text).toContain("--user 501:20")
    expect(text).toContain("--mount type=bind,src=/work/ws/src/a.ts,dst=/work/ws/src/a.ts,readonly")
    expect(text).toContain("--mount type=bind,src=/work/ws/dist,dst=/work/ws/dist ")
    expect(text).toContain("--env CI=1")
    expect(text).not.toContain("PATH=/ignored")
    expect(text).toContain("--env HOME=/tmp/home node:22 node build.js")
  })

  it("opens the bridge network only for an open policy", () => {
    const plan = planned(host("win32", { docker: "docker" }), {
      mechanism: Sandbox.Docker({ image: "node:22" }),
      policy: { network: true }
    })
    expect(ExecSandbox.docker(plan, ["true"], {}).join(" ")).toContain("--network bridge")
  })
})

describe("wrap and environment", () => {
  it("redirects the temporary and home directories into the confinement", () => {
    const seatbelt = ExecSandbox.wrap(planned(darwin), ["true"], {})
    expect(seatbelt.argv.slice(0, 2)).toEqual(["/usr/bin/sandbox-exec", "-p"])
    expect(seatbelt.env["TMPDIR"]).toBe("/work/ws/.flows/sandbox/run1")
    expect(seatbelt.env["HOME"]).toBe("/work/ws/.flows/sandbox/run1/home")
    const bubblewrap = ExecSandbox.wrap(planned(linux), ["true"], {})
    expect(bubblewrap.env["TMPDIR"]).toBe("/tmp")
    expect(bubblewrap.env["HOME"]).toBe("/tmp/home")
    expect(bubblewrap.env["XDG_CACHE_HOME"]).toBe("/tmp/cache")
  })

  it("keeps corepack's binary cache where the host has it, so a shim still finds its package manager", () => {
    const plan = planned(linux)
    expect(ExecSandbox.environment(plan, {}, "/home/dev")["COREPACK_HOME"]).toBe("/home/dev/.cache/node/corepack")
    expect(ExecSandbox.environment(plan, { XDG_CACHE_HOME: "/var/cache/dev" }, "/home/dev")["COREPACK_HOME"]).toBe(
      "/var/cache/dev/node/corepack"
    )
    expect(ExecSandbox.environment(plan, { COREPACK_HOME: "/opt/corepack" }, "/home/dev")["COREPACK_HOME"]).toBe(
      "/opt/corepack"
    )
    expect(ExecSandbox.environment(plan)["COREPACK_HOME"]).not.toBe("/tmp/cache/node/corepack")
  })
})

describe("diagnose", () => {
  it("names the workspace paths a tool was denied and which side of the boundary they fell on", () => {
    const plan = planned(linux)
    const text = [
      "/bin/sh: 1: cannot create /work/ws/pkg/notes.txt: Read-only file system",
      "Error: ENOENT: no such file or directory, open '/work/ws/src/b.ts'",
      "/bin/sh: /work/ws/dist/x.js: Operation not permitted",
      "EACCES: permission denied, open '/etc/passwd'"
    ].join("\n")
    const note = ExecSandbox.diagnose(plan, text)
    expect(note).toContain("sandbox: pkg/notes.txt is outside the declared write set")
    expect(note).toContain("sandbox: src/b.ts is outside the declared read set")
    expect(note).toContain("sandbox: dist/x.js was denied inside the declared set")
    expect(note).not.toContain("/etc/passwd")
    expect(note).toContain("bubblewrap, network none")
  })

  it("stays silent when the output names no workspace path", () => {
    expect(ExecSandbox.diagnose(planned(linux), "everything is fine")).toBeUndefined()
  })

  it("reports an escape bubblewrap never mounted as a write outside the declared set", () => {
    // Under bubblewrap an undeclared path is absent rather than forbidden, and
    // dash reports that absence as "Directory nonexistent" against a bare
    // relative path; seatbelt says EPERM for the same escape.
    const plan = planned(linux, { reads: [], writes: ["out"] })
    const note = ExecSandbox.diagnose(
      plan,
      "/bin/sh: 1: cannot create linkdir/target.txt: Directory nonexistent"
    )
    expect(note).toContain("sandbox: pkg/linkdir/target.txt is outside the declared write set")
    const rootDenied = ExecSandbox.diagnose(plan, "sh: line 1: cannot create out/note.txt: Read-only file system")
    expect(rootDenied).toContain("sandbox: pkg/out/note.txt is outside the declared write set")
  })

  it("reports a write that leaves the workspace through a symlink as outside the write set", () => {
    // The declared output out.txt sits at the top level, so the write
    // directory is the root itself and linkdir/target.txt is lexically
    // covered; linkdir points outside the workspace, so the write escaped.
    const root = NodeFs.realpathSync(NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "smthrs-ws-")))
    const elsewhere = NodeFs.realpathSync(NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "smthrs-out-")))
    try {
      NodeFs.symlinkSync(elsewhere, NodePath.join(root, "linkdir"))
      const plan: ExecSandbox.Plan = {
        ...planned(linux, { reads: [], writes: ["out.txt"] }),
        workspaceRoot: root,
        cwd: root,
        writes: [root]
      }
      const note = ExecSandbox.diagnose(plan, "/bin/sh: 1: cannot create linkdir/target.txt: Directory nonexistent")
      expect(note).toMatch(/sandbox: linkdir\/target\.txt resolves to .* outside the declared write set/)
      const inside = ExecSandbox.diagnose(plan, "/bin/sh: 1: cannot create sub/target.txt: Directory nonexistent")
      expect(inside).toContain("sandbox: sub/target.txt was denied inside the declared set")
    } finally {
      NodeFs.rmSync(root, { recursive: true, force: true })
      NodeFs.rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  it("reads relative paths against the working directory", () => {
    const plan = planned(darwin, { reads: ["src/a.ts"], writes: [] })
    const note = ExecSandbox.diagnose(plan, "sh: line 1: out/esc: Operation not permitted")
    expect(note).toContain(`sandbox: ${NodePath.posix.join("pkg", "out/esc")} is outside the declared read set`)
  })
})

describe("host", () => {
  it("resolves executables on PATH and refuses a missing one", () => {
    const real = ExecSandbox.host()
    expect(real.platform).toBe(process.platform)
    expect(real.executable("definitely-not-a-real-executable-xyz")).toBeUndefined()
    const node = real.executable(NodePath.basename(process.execPath))
    if (node !== undefined) expect(NodePath.isAbsolute(node)).toBe(true)
    expect(real.exists(process.execPath)).toBe(true)
    expect(real.isDirectory(NodePath.dirname(process.execPath))).toBe(true)
    expect(real.isDirectory("/definitely/not/a/real/directory")).toBe(false)
    expect(real.entries?.("/definitely/not/a/real/directory")).toBeUndefined()
    expect(real.realpath?.("/definitely/not/a/real/path")).toBeUndefined()
  })
})
