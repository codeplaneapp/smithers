/*
 * Startup wiring tests, run by `bun test`.
 *
 * Importing server.js must start nothing: main() only runs under
 * `import.meta.main`. That property is what lets this file assert the
 * listener's body cap without opening a listener or a database.
 */
import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { maxActionCacheBodyBytes } from "../protocol.js"
import { main, requestBodyCap } from "../server.js"

describe("requestBodyCap", () => {
  test("sits one chunk above the configured artifact bound", () => {
    const bound = 16 * 1024 * 1024
    expect(requestBodyCap(bound)).toBe(bound + 1024 * 1024)
  })

  test("never drops below the action-cache bound when the artifact bound is tiny", () => {
    // An operator may bound artifacts to one byte; the action-cache routes
    // still accept their one-mebibyte documents through the same listener.
    expect(requestBodyCap(1)).toBe(maxActionCacheBodyBytes + 1024 * 1024)
  })

  test("keeps the listener allocation below Bun's 128 MiB default", () => {
    expect(requestBodyCap(16 * 1024 * 1024)).toBe(17 * 1024 * 1024)
  })
})

const environment = {
  DATABASE_URL: "postgres://smthrs:secret@cache:5432/smithers_build_cache",
  PORT: "8080",
  SMITHERS_CACHE_MAX_BODY_BYTES: String(16 * 1024 * 1024),
  SMITHERS_CACHE_READ_TOKEN: "a-read-token-with-production-entropy",
  SMITHERS_CACHE_WRITE_TOKEN: "a-write-token-with-production-entropy"
}

const runtime = ({ schemaVersion = 1 } = {}) => {
  const process = new EventEmitter()
  process.exitCode = undefined
  const calls = { close: 0, stop: 0, serve: 0, options: null, logs: [] }
  const sql = async () => [{ schema_version: schemaVersion }]
  sql.close = async () => {
    calls.close += 1
  }
  const server = {
    port: 8080,
    stop: async () => {
      calls.stop += 1
    }
  }
  return {
    calls,
    runtime: {
      process,
      openSql: () => sql,
      serve: (options) => {
        calls.serve += 1
        calls.options = options
        return server
      },
      console: {
        error: (...parts) => calls.logs.push(["error", ...parts]),
        warn: (...parts) => calls.logs.push(["warn", ...parts]),
        log: (...parts) => calls.logs.push(["log", ...parts])
      }
    }
  }
}

describe("server lifecycle", () => {
  test("checks schema before binding and closes listener and SQL exactly once", async () => {
    const fake = runtime()
    const started = await main(environment, fake.runtime)
    expect(started).not.toBeNull()
    expect(fake.calls.serve).toBe(1)
    expect(fake.calls.options.hostname).toBe("0.0.0.0")
    expect(fake.calls.options.maxRequestBodySize).toBe(17 * 1024 * 1024)
    await started.close()
    await started.close()
    expect(fake.calls.stop).toBe(1)
    expect(fake.calls.close).toBe(1)
    expect(fake.runtime.process.listenerCount("SIGINT")).toBe(0)
    expect(fake.runtime.process.listenerCount("SIGTERM")).toBe(0)
  })

  test("binds unauthenticated direct development mode to loopback only", async () => {
    const fake = runtime()
    const started = await main({
      ...environment,
      SMITHERS_CACHE_READ_TOKEN: "",
      SMITHERS_CACHE_WRITE_TOKEN: ""
    }, fake.runtime)
    expect(fake.calls.options.hostname).toBe("127.0.0.1")
    expect(fake.calls.logs.some((line) => line[0] === "warn")).toBe(true)
    await started.close()
  })

  test("refuses an unsupported schema before opening a listener", async () => {
    const fake = runtime({ schemaVersion: 0 })
    expect(await main(environment, fake.runtime)).toBeNull()
    expect(fake.calls.serve).toBe(0)
    expect(fake.calls.close).toBe(1)
    expect(fake.runtime.process.exitCode).toBe(75)
  })

  test("reports configuration errors before opening SQL", async () => {
    const fake = runtime()
    let opened = false
    fake.runtime.openSql = () => {
      opened = true
    }
    expect(await main({ PORT: "0" }, fake.runtime)).toBeNull()
    expect(opened).toBe(false)
    expect(fake.runtime.process.exitCode).toBe(78)
  })

  test("coalesces repeated termination signals into one shutdown", async () => {
    const fake = runtime()
    const started = await main(environment, fake.runtime)
    fake.runtime.process.emit("SIGTERM")
    fake.runtime.process.emit("SIGINT")
    await started.close()
    expect(fake.calls.stop).toBe(1)
    expect(fake.calls.close).toBe(1)
  })
})
