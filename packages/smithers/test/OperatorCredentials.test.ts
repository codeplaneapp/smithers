import { Effect, Redacted } from "effect"
import { Cli } from "incur"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createCredentialsCli, readSecret, withCredentials } from "../src/operator/Credentials.ts"

const roots: Array<string> = []
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-operator-credentials-"))
  roots.push(root)
  return root
}
const invoke = async (root: string, args: Array<string>) => {
  let output = ""
  let code = 0
  await Cli.create("smthrs").command(createCredentialsCli()).serve(["credentials", ...args, "--root", root, "--json"], {
    stdout: (value) => {
      output += value
    },
    exit: (value) => {
      code = value
    }
  })
  return { code, data: JSON.parse(output) as any, output }
}

beforeEach(() => {
  vi.stubEnv("SMITHERS_REMOTE", undefined)
  vi.stubEnv("SMITHERS_CREDENTIAL_KEY", Buffer.alloc(32, 42).toString("base64"))
  vi.stubEnv("SMITHERS_OPERATOR_TEST_SECRET", "fixture-secret-before-rotation")
})
afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("operator credentials", () => {
  it("persists encrypted secrets, rotates them, and revokes references without emitting plaintext", async () => {
    const root = fixture()
    const added = await invoke(root, [
      "add",
      "github",
      "--name",
      "GitHub",
      "--secret-env",
      "SMITHERS_OPERATOR_TEST_SECRET"
    ])
    expect(added.code).toBe(0)
    expect(added.data).toEqual({ id: "github", name: "GitHub" })
    expect(added.output).not.toContain("fixture-secret")
    const resolve = () =>
      withCredentials(
        { root },
        (service) => service.get("github").pipe(Effect.flatMap(service.resolve), Effect.map(Redacted.value)),
        true
      )
    expect(await resolve()).toBe("fixture-secret-before-rotation")
    const database = new DatabaseSync(join(root, ".flows", "control.db"), { readOnly: true })
    const sealed = database.prepare("SELECT ciphertext, nonce, version FROM control_credentials WHERE id = ?").get(
      "github"
    )
    database.close()
    expect(sealed).toMatchObject({ version: 1 })
    expect(JSON.stringify(sealed)).not.toContain("fixture-secret")
    expect(readFileSync(join(root, ".flows", "control.db")).includes(Buffer.from("fixture-secret"))).toBe(false)
    vi.stubEnv("SMITHERS_OPERATOR_TEST_SECRET", "fixture-secret-after-rotation")
    const rotated = await invoke(root, ["rotate", "github", "--secret-env", "SMITHERS_OPERATOR_TEST_SECRET"])
    expect(rotated.code).toBe(0)
    expect(rotated.output).not.toContain("fixture-secret")
    expect(await resolve()).toBe("fixture-secret-after-rotation")
    vi.stubEnv("SMITHERS_CREDENTIAL_KEY", undefined)
    expect((await invoke(root, ["list"])).data).toEqual([{ id: "github", name: "GitHub" }])
    expect((await invoke(root, ["revoke", "github"])).data).toEqual({ id: "github", revoked: true })
    expect((await invoke(root, ["list"])).data).toEqual([])
  })

  it("refuses duplicate IDs, missing keys, and invalid secret sources without leaking secrets", async () => {
    const root = fixture()
    vi.stubEnv("SMITHERS_CREDENTIAL_KEY", undefined)
    const missingKey = await invoke(root, ["add", "a", "--name", "A", "--secret-env", "SMITHERS_OPERATOR_TEST_SECRET"])
    expect(missingKey.code).toBe(1)
    expect(missingKey.output).toContain("SMITHERS_CREDENTIAL_KEY")
    expect(existsSync(join(root, ".flows"))).toBe(false)
    vi.stubEnv("SMITHERS_CREDENTIAL_KEY", "invalid-key")
    const invalidKey = await invoke(root, ["add", "a", "--name", "A", "--secret-env", "SMITHERS_OPERATOR_TEST_SECRET"])
    expect(invalidKey.code).toBe(1)
    expect(invalidKey.output).not.toContain("invalid-key")
    expect(existsSync(join(root, ".flows"))).toBe(false)
    vi.stubEnv("SMITHERS_CREDENTIAL_KEY", Buffer.alloc(32, 42).toString("base64"))
    expect((await invoke(root, ["add", "a", "--name", "A", "--secret-env", "SMITHERS_OPERATOR_TEST_SECRET"])).code)
      .toBe(0)
    const duplicate = await invoke(root, ["add", "a", "--name", "A", "--secret-env", "SMITHERS_OPERATOR_TEST_SECRET"])
    expect(duplicate.code).toBe(1)
    expect(duplicate.output).not.toContain("fixture-secret")
    expect((await invoke(root, ["rotate", "missing", "--secret-env", "SMITHERS_OPERATOR_TEST_SECRET"])).code).toBe(1)
    expect((await invoke(root, ["add", "bad", "--name", "Bad"])).code).toBe(1)
    expect((await invoke(root, ["add", "bad", "--name", "Bad", "--secret-env", "MISSING_TEST_ENV"])).code).toBe(1)
    expect((await invoke(root, ["add", "bad", "--name", "Bad", "--secret-file", "missing"])).code).toBe(1)
    expect(
      (await invoke(root, [
        "add",
        "bad",
        "--name",
        "Bad",
        "--secret-env",
        "SMITHERS_OPERATOR_TEST_SECRET",
        "--secret-file",
        "missing"
      ])).code
    ).toBe(1)
  })

  it("reads a secret file relative to the project and strips only its final newline", async () => {
    const root = fixture()
    writeFileSync(join(root, "secret"), "file-secret\nsecond-line\r\n", { mode: 0o600 })
    expect(Redacted.value(readSecret({ secretFile: "secret" }, root))).toBe("file-secret\nsecond-line")
    const result = await invoke(root, ["add", "file", "--name", "File", "--secret-file", "secret"])
    expect(result.code).toBe(0)
    expect(result.output).not.toContain("file-secret")
    const remoteRoot = fixture()
    expect((await invoke(remoteRoot, ["list", "--remote", "http://localhost:3000"])).code).toBe(1)
    expect(existsSync(join(remoteRoot, ".flows"))).toBe(false)
  })
})
