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
  it("names every variable rc.0 reads, with an alias for each", () => {
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
    for (const name of Environment.names) {
      expect(name.alias).toBe(name.name.replace("SMITHERS_", "FLOWS_"))
      expect(name.purpose.length).toBeGreaterThan(0)
    }
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
    expect(
      Environment.readInteger({ FLOWS_DETACHED_ADMISSION_TIMEOUT_MS: "42" }, "SMITHERS_DETACHED_ADMISSION_TIMEOUT_MS")
    )
      .toBe(42)
    for (const value of ["0", "-1", "soon", ""]) {
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

  it("names the backend and the error code for every other value", () => {
    for (const backend of ["pglite", "postgres", "mysql"]) {
      const refusal = Environment.unsupportedBackend(backend)

      expect(refusal).toContain("unsupported_database")
      expect(refusal).toContain(backend)
      expect(refusal).toContain("https://smithers.sh/migration/1.0#databases")
    }
  })
})
