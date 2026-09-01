/**
 * The `SMITHERS_*` environment contract, and its rc.0 `FLOWS_*` aliases.
 *
 * Both halves are pinned here because the alias set is temporary: it exists
 * only so a project configured against the imported repository keeps working
 * through the release candidates, and it is removed at 1.0.0. A name that
 * gained an alias without appearing in {@link Environment.names}, or a `FLOWS_`
 * spelling that outlived the table, is a contract change.
 */
import { describe, expect, it } from "vitest"
import * as Environment from "../src/Environment.ts"

describe("the environment contract", () => {
  it("names every variable rc.0 reads", () => {
    expect(Environment.names.map((name) => name.name)).toEqual([
      "SMITHERS_REMOTE",
      "SMITHERS_API_KEY",
      "SMITHERS_MCP_CONFIG",
      "SMITHERS_OPENAI_AUTH",
      "SMITHERS_TEST_COMMAND",
      "SMITHERS_TEST_CONTAINER",
      "SMITHERS_TEST_CWD",
      "SMITHERS_TEST_TIMEOUT_MS",
      "SMITHERS_BACKEND",
      "SMITHERS_BUG_ENDPOINT",
      "SMITHERS_JJ_PATH",
      "SMITHERS_DETACHED_ADMISSION_TIMEOUT_MS",
      "SMITHERS_INSIDE_RUN",
      "SMITHERS_RUN_ID"
    ])
    for (const name of Environment.names) expect(name.purpose.length).toBeGreaterThan(0)
  })

  it("gives a `FLOWS_*` alias to the four families the contract renames, and to nothing else", () => {
    // rc-contract section 4: `FLOWS_REMOTE`, `FLOWS_MCP_CONFIG`,
    // `FLOWS_OPENAI_AUTH`, and `FLOWS_TEST_*` are the names the imported CLI
    // read, so they are the names that keep working through rc.0. Aliasing
    // every entry invented four spellings — `FLOWS_BACKEND`, `FLOWS_JJ_PATH`,
    // `FLOWS_INSIDE_RUN`, `FLOWS_RUN_ID` — that nothing has ever set, and
    // widened a contract whose whole purpose is to be closed. `SMITHERS_API_KEY`
    // is new in rc.0 and has no 0.x spelling to alias.
    expect(Environment.names.filter((name) => name.alias !== undefined).map((name) => name.alias)).toEqual([
      "FLOWS_REMOTE",
      "FLOWS_MCP_CONFIG",
      "FLOWS_OPENAI_AUTH",
      "FLOWS_TEST_COMMAND",
      "FLOWS_TEST_CONTAINER",
      "FLOWS_TEST_CWD",
      "FLOWS_TEST_TIMEOUT_MS"
    ])
    expect(Environment.read({ FLOWS_BACKEND: "pglite" }, "SMITHERS_BACKEND")).toBeUndefined()
    expect(Environment.read({ FLOWS_API_KEY: "token" }, "SMITHERS_API_KEY")).toBeUndefined()
    expect(Environment.read({ FLOWS_RUN_ID: "run-1" }, "SMITHERS_RUN_ID")).toBeUndefined()
  })

  it("reads the canonical name first and the alias second", () => {
    expect(Environment.read({ SMITHERS_REMOTE: "canonical" }, "SMITHERS_REMOTE")).toBe("canonical")
    expect(Environment.read({ FLOWS_REMOTE: "alias" }, "SMITHERS_REMOTE")).toBe("alias")
    expect(Environment.read({ SMITHERS_REMOTE: "canonical", FLOWS_REMOTE: "alias" }, "SMITHERS_REMOTE"))
      .toBe("canonical")
  })

  it("treats an exported-but-empty value as unset, on both spellings", () => {
    // An exported blank is how a shell spells "not configured"; reading it as
    // a value turns `export SMITHERS_API_KEY=` into an empty bearer token.
    expect(Environment.read({ SMITHERS_REMOTE: "" }, "SMITHERS_REMOTE")).toBeUndefined()
    expect(Environment.read({ SMITHERS_REMOTE: "", FLOWS_REMOTE: "alias" }, "SMITHERS_REMOTE")).toBe("alias")
    expect(Environment.read({ SMITHERS_REMOTE: "", FLOWS_REMOTE: "" }, "SMITHERS_REMOTE")).toBeUndefined()
  })

  it("reads a name the table does not carry without inventing an alias", () => {
    expect(Environment.read({ ANTHROPIC_API_KEY: "key" }, "ANTHROPIC_API_KEY")).toBe("key")
    expect(Environment.read({ FLOWS_ANTHROPIC_API_KEY: "key" }, "ANTHROPIC_API_KEY")).toBeUndefined()
  })

  it("reads a positive integer and ignores anything else", () => {
    expect(
      Environment.readInteger(
        { SMITHERS_DETACHED_ADMISSION_TIMEOUT_MS: "5000" },
        "SMITHERS_DETACHED_ADMISSION_TIMEOUT_MS"
      )
    )
      .toBe(5000)
    expect(Environment.readInteger({ FLOWS_TEST_TIMEOUT_MS: "42" }, "SMITHERS_TEST_TIMEOUT_MS")).toBe(42)
    for (const value of ["30abc", " 30", "30 ", "0", "-1", "3e2", "soon", ""]) {
      expect(
        Environment.readInteger(
          { SMITHERS_DETACHED_ADMISSION_TIMEOUT_MS: value },
          "SMITHERS_DETACHED_ADMISSION_TIMEOUT_MS"
        )
      )
        .toBeUndefined()
    }
    expect(Environment.readInteger({}, "SMITHERS_DETACHED_ADMISSION_TIMEOUT_MS")).toBeUndefined()
  })
})

describe("the database-backend refusal", () => {
  it("accepts sqlite and an unset value", () => {
    expect(Environment.unsupportedBackend(undefined)).toBeUndefined()
    expect(Environment.unsupportedBackend("")).toBeUndefined()
    expect(Environment.unsupportedBackend("sqlite")).toBeUndefined()
  })

  it("uses rc-contract section 2's sentence verbatim for every other value", () => {
    // The contract prints one exact sentence, and an operator's script greps
    // for it. Paraphrasing it — this module said "pglite is not supported in
    // 1.0.0-rc.0" and never named the fix — is a contract change. The literal
    // is repeated here rather than read off the module, so a rewritten
    // constant fails instead of agreeing with itself.
    const expected = "unsupported_database: 1.0.0-rc.0 supports local SQLite only. " +
      "PostgreSQL and PGlite are not available. Unset SMITHERS_BACKEND or set it to sqlite. " +
      "See https://smithers.sh/migration/1.0#databases"

    expect(Environment.unsupportedBackendMessage).toBe(expected)
    for (const backend of ["pglite", "postgres", "mysql"]) {
      expect(Environment.unsupportedBackend(backend)).toBe(expected)
    }
  })
})
