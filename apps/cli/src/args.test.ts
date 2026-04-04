import { describe, expect, test } from "bun:test"

import { parseCliArgs } from "./args"

describe("parseCliArgs", () => {
  test("returns help when no command is provided", () => {
    expect(parseCliArgs([])).toEqual({
      ok: true,
      command: {
        kind: "help",
      },
    })
  })

  test("parses daemon command", () => {
    expect(parseCliArgs(["daemon"])).toEqual({
      ok: true,
      command: {
        kind: "daemon",
      },
    })
  })

  test("parses start command with open flag", () => {
    expect(parseCliArgs(["start", "--open"])).toEqual({
      ok: true,
      command: {
        kind: "start",
        host: "127.0.0.1",
        port: 4173,
        openWeb: true,
        webUrl: "http://127.0.0.1:4173",
      },
    })
  })

  test("parses start command with custom web URL", () => {
    expect(parseCliArgs(["start", "--web-url", "http://localhost:5173"])).toEqual({
      ok: true,
      command: {
        kind: "start",
        host: "127.0.0.1",
        port: 4173,
        openWeb: false,
        webUrl: "http://localhost:5173",
      },
    })
  })

  test("parses start command with custom host and port", () => {
    expect(parseCliArgs(["start", "--host", "0.0.0.0", "--port", "9999"])).toEqual({
      ok: true,
      command: {
        kind: "start",
        host: "0.0.0.0",
        port: 9999,
        openWeb: false,
        webUrl: "http://127.0.0.1:9999",
      },
    })
  })

  test("parses web command options", () => {
    expect(parseCliArgs(["web", "--host", "0.0.0.0", "--port", "9001", "--open"])).toEqual({
      ok: true,
      command: {
        kind: "web",
        host: "0.0.0.0",
        port: 9001,
        openWeb: true,
      },
    })
  })

  test("rejects invalid web port", () => {
    expect(parseCliArgs(["web", "--port", "abc"])).toEqual({
      ok: false,
      error: "Invalid --port value: abc",
    })
  })

  test("rejects unknown command", () => {
    expect(parseCliArgs(["unknown"])).toEqual({
      ok: false,
      error: "Unknown command: unknown",
    })
  })

  test("parses ui dashboard target", () => {
    expect(parseCliArgs(["ui"])).toEqual({
      ok: true,
      command: {
        kind: "ui",
        host: "127.0.0.1",
        port: 4173,
        openWeb: true,
        allowDiscovery: true,
        target: {
          kind: "dashboard",
        },
      },
    })
  })

  test("parses ui run deep link target", () => {
    expect(parseCliArgs(["ui", "run", "run-123"])).toEqual({
      ok: true,
      command: {
        kind: "ui",
        host: "127.0.0.1",
        port: 4173,
        openWeb: true,
        allowDiscovery: true,
        target: {
          kind: "run",
          runId: "run-123",
        },
      },
    })
  })

  test("parses ui node deep link target", () => {
    expect(parseCliArgs(["ui", "node", "run-123/deploy"])).toEqual({
      ok: true,
      command: {
        kind: "ui",
        host: "127.0.0.1",
        port: 4173,
        openWeb: true,
        allowDiscovery: true,
        target: {
          kind: "node",
          runId: "run-123",
          nodeId: "deploy",
        },
      },
    })
  })

  test("parses ui approvals target with no-open and custom port", () => {
    expect(parseCliArgs(["ui", "approvals", "--no-open", "--port", "9999"])).toEqual({
      ok: true,
      command: {
        kind: "ui",
        host: "127.0.0.1",
        port: 9999,
        openWeb: false,
        allowDiscovery: false,
        target: {
          kind: "approvals",
        },
      },
    })
  })

  test("rejects malformed ui node target", () => {
    expect(parseCliArgs(["ui", "node", "run-only"])).toEqual({
      ok: false,
      error: "Invalid node target. Expected <run-id>/<node-id>",
    })
  })
})
