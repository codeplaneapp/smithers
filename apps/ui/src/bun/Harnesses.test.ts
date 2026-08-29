import { describe, expect, test } from "bun:test"
import { HARNESS_IDS } from "smithers-shared/LocalApp"
import {
  decodeJwtClaims,
  DETECTORS,
  detectHarnessesWith,
  findBinary,
  harnessCandidateDirs,
  parseVersionLine
} from "./Harnesses"
import type { HarnessHost } from "./Harnesses"

/*
 * The detection table over a fake host: files, binaries and env are data,
 * so the sign-in signals and the candidate order hold on any machine.
 */

const HOME = "/Users/u"

interface Fake {
  readonly files?: Record<string, string>
  readonly binaries?: ReadonlyArray<string>
  readonly env?: Record<string, string | undefined>
  readonly versions?: Record<string, string | null>
  readonly platform?: string
}

const jwt = (claims: Record<string, unknown>): string =>
  `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`

const host = (fake: Fake = {}): HarnessHost & { readonly probed: Array<string> } => {
  const files = fake.files ?? {}
  const binaries = new Set(fake.binaries ?? [])
  const probed: Array<string> = []
  return {
    env: { PATH: "/usr/bin:/bin", ...fake.env },
    home: HOME,
    platform: fake.platform ?? "darwin",
    listDir: (dir) => {
      const entries = new Set<string>()
      for (const path of [...Object.keys(files), ...binaries]) {
        if (path.startsWith(`${dir}/`)) entries.add(path.slice(dir.length + 1).split("/")[0] ?? "")
      }
      return [...entries]
    },
    isFile: (path) => path in files || binaries.has(path),
    readText: (path) => files[path] ?? null,
    version: async (binary) => {
      probed.push(binary)
      const versions = fake.versions ?? {}
      return binary in versions ? versions[binary] ?? null : "1.2.3"
    },
    probed
  }
}

describe("the candidate dirs", () => {
  test("explicit dirs come before PATH, nvm highest first", () => {
    const h = host({
      binaries: [
        "/Users/u/.nvm/versions/node/v22.19.0/bin/node",
        "/Users/u/.nvm/versions/node/v24.1.0/bin/node"
      ]
    })
    expect(harnessCandidateDirs(h)).toEqual([
      "/Users/u/.local/bin",
      "/Users/u/.bun/bin",
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/Users/u/.nvm/versions/node/v24.1.0/bin",
      "/Users/u/.nvm/versions/node/v22.19.0/bin",
      "/Users/u/.cargo/bin",
      "/Users/u/.opencode/bin"
    ])
  })

  test("findBinary prefers a candidate dir over PATH and falls back to PATH", () => {
    const h = host({ binaries: ["/Users/u/.local/bin/claude", "/usr/bin/claude", "/usr/bin/codex"] })
    expect(findBinary("claude", h)).toBe("/Users/u/.local/bin/claude")
    expect(findBinary("codex", h)).toBe("/usr/bin/codex")
    expect(findBinary("gemini", h)).toBeNull()
  })
})

describe("the table", () => {
  test("covers every contract id in order with an interactive launch", () => {
    expect(DETECTORS.map((detector) => detector.id)).toEqual([...HARNESS_IDS])
    for (const detector of DETECTORS) {
      expect(detector.launch[0]).toBe(detector.binary)
      expect(detector.launch).not.toContain("--dangerously-skip-permissions")
      expect(detector.launch).not.toContain("--yolo")
    }
  })

  test("an absent binary is unavailable even with credentials on disk", async () => {
    const h = host({ files: { "/Users/u/.claude.json": JSON.stringify({ oauthAccount: { emailAddress: "a@b.c" } }) } })
    const [claude] = await detectHarnessesWith(h)
    expect(claude).toEqual({
      id: "claude",
      displayName: "Claude Code",
      binary: null,
      version: null,
      status: "unavailable",
      account: null,
      launch: { argv: ["claude"] }
    })
    expect(h.probed).toEqual([])
  })

  test("claude: oauthAccount email and organization, else .credentials.json, else ANTHROPIC_API_KEY", async () => {
    const claudeOf = async (fake: Fake) => (await detectHarnessesWith(host({ binaries: ["/opt/homebrew/bin/claude"], ...fake })))[0]
    expect(await claudeOf({
      files: { "/Users/u/.claude.json": JSON.stringify({ oauthAccount: { emailAddress: "will@codeplane.app", organizationName: "Org" } }) }
    })).toMatchObject({ status: "signed-in", account: { email: "will@codeplane.app", label: "Org" }, version: "1.2.3" })
    expect(await claudeOf({ files: { "/Users/u/.claude/.credentials.json": "{}" } })).toMatchObject({ status: "signed-in", account: null })
    expect(await claudeOf({ env: { CLAUDE_CONFIG_DIR: "/cfg" }, files: { "/cfg/.credentials.json": "{}" } })).toMatchObject({ status: "signed-in" })
    expect(await claudeOf({ env: { ANTHROPIC_API_KEY: "sk-x" } })).toMatchObject({ status: "api-key", account: { label: "ANTHROPIC_API_KEY" } })
    expect(await claudeOf({})).toMatchObject({ status: "binary-only", account: null, binary: "/opt/homebrew/bin/claude" })
  })

  test("codex: the id_token email claim, then the auth.json key, then OPENAI_API_KEY", async () => {
    const codexOf = async (fake: Fake) => (await detectHarnessesWith(host({ binaries: ["/Users/u/.bun/bin/codex"], ...fake })))[1]
    expect(await codexOf({
      files: { "/Users/u/.codex/auth.json": JSON.stringify({ tokens: { id_token: jwt({ email: "will@codeplane.app" }) } }) }
    })).toMatchObject({ status: "signed-in", account: { email: "will@codeplane.app" } })
    expect(await codexOf({
      env: { CODEX_HOME: "/cx" },
      files: { "/cx/auth.json": JSON.stringify({ tokens: { access_token: "tok" } }) }
    })).toMatchObject({ status: "signed-in", account: null })
    expect(await codexOf({ files: { "/Users/u/.codex/auth.json": JSON.stringify({ OPENAI_API_KEY: "sk-1" }) } })).toMatchObject({ status: "api-key" })
    expect(await codexOf({ env: { OPENAI_API_KEY: "sk-2" } })).toMatchObject({ status: "api-key", account: { label: "OPENAI_API_KEY" } })
    expect(await codexOf({})).toMatchObject({ status: "binary-only" })
  })

  test("gemini, kimi, opencode, hermes, pi read their config files", async () => {
    const all = await detectHarnessesWith(host({
      binaries: ["/opt/homebrew/bin/gemini", "/Users/u/.local/bin/kimi", "/Users/u/.opencode/bin/opencode", "/Users/u/.local/bin/hermes", "/usr/local/bin/pi"],
      files: {
        "/Users/u/.gemini/oauth_creds.json": "{}",
        "/Users/u/.gemini/google_accounts.json": JSON.stringify({ active: "me@gmail.com" }),
        "/Users/u/.kimi/credentials/kimi-code.json": "{}",
        "/Users/u/.local/share/opencode/auth.json": JSON.stringify({ anthropic: { type: "oauth", access: "x" }, openai: {} }),
        "/Users/u/.hermes/auth.json": JSON.stringify({ providers: { openai: "k" } }),
        "/Users/u/.pi/agent/auth.json": "[]"
      }
    }))
    const byId = Object.fromEntries(all.map((harness) => [harness.id, harness]))
    expect(byId.gemini).toMatchObject({ status: "signed-in", account: { email: "me@gmail.com" } })
    expect(byId.kimi).toMatchObject({ status: "signed-in", account: { label: "kimi-code" } })
    expect(byId.opencode).toMatchObject({ status: "signed-in", account: { label: "anthropic" } })
    expect(byId.hermes).toMatchObject({ status: "signed-in", account: { label: "~/.hermes/auth.json" } })
    expect(byId.pi).toMatchObject({ status: "binary-only", binary: "/usr/local/bin/pi" })
  })

  test("versions are probed in parallel for installed binaries only, null when the probe fails", async () => {
    const h = host({
      binaries: ["/opt/homebrew/bin/claude", "/opt/homebrew/bin/hermes"],
      versions: { "/opt/homebrew/bin/hermes": null }
    })
    const all = await detectHarnessesWith(h)
    expect(h.probed.sort()).toEqual(["/opt/homebrew/bin/claude", "/opt/homebrew/bin/hermes"])
    expect(all.find((harness) => harness.id === "claude")?.version).toBe("1.2.3")
    expect(all.find((harness) => harness.id === "hermes")?.version).toBeNull()
  })
})

describe("helpers", () => {
  test("parseVersionLine picks the version out of a CLI's banner", () => {
    expect(parseVersionLine("2.1.247 (Claude Code)\n")).toBe("2.1.247")
    expect(parseVersionLine("codex-cli 0.149.1")).toBe("0.149.1")
    expect(parseVersionLine("crush version v0.1.11")).toBe("0.1.11")
    expect(parseVersionLine("kimi, version 1.48.0")).toBe("1.48.0")
    expect(parseVersionLine("0.0.1780433882-g06340c (released 2026-06-02)")).toBe("0.0.1780433882-g06340c")
    expect(parseVersionLine("\n  unknown\n")).toBe("unknown")
    expect(parseVersionLine("")).toBeNull()
  })

  test("decodeJwtClaims never verifies and never throws", () => {
    expect(decodeJwtClaims(jwt({ email: "a@b.c" }))).toEqual({ email: "a@b.c" })
    expect(decodeJwtClaims("not-a-jwt")).toBeNull()
    expect(decodeJwtClaims("a.!!!.c")).toBeNull()
    expect(decodeJwtClaims(42)).toBeNull()
  })
})
