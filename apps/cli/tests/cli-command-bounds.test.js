import { describe, expect, test } from "bun:test";
import { CLI_JSON_ARGUMENT_MAX_BYTES } from "../src/json-args.js";
import {
  CLI_ARGUMENT_MAX_LENGTH,
  CLI_IDENTIFIER_MAX_LENGTH,
  CLI_TEXT_ARGUMENT_MAX_LENGTH,
  assertCliArgumentBounds,
  wrapCliCommandHandlersWithInputBounds,
} from "../src/cli-command-bounds.js";

describe("CLI command input bounds", () => {
  test("accepts exact documented string limits for command args and options", () => {
    expect(() =>
      assertCliArgumentBounds(
        {
          runId: "r".repeat(CLI_IDENTIFIER_MAX_LENGTH),
          workflow: "w".repeat(CLI_ARGUMENT_MAX_LENGTH),
          prompt: "p".repeat(CLI_TEXT_ARGUMENT_MAX_LENGTH),
          input: "i".repeat(CLI_JSON_ARGUMENT_MAX_BYTES),
          retry: 3,
          unset: null,
        },
        "args",
      ),
    ).not.toThrow();
  });

  test("rejects command identifiers, paths, long text, and JSON payloads above their limits", () => {
    expect(() => assertCliArgumentBounds({ runId: "r".repeat(CLI_IDENTIFIER_MAX_LENGTH + 1) }, "args")).toThrow(
      new RegExp(`maximum length of ${CLI_IDENTIFIER_MAX_LENGTH}`),
    );
    expect(() => assertCliArgumentBounds({ workflow: "w".repeat(CLI_ARGUMENT_MAX_LENGTH + 1) }, "args")).toThrow(
      new RegExp(`maximum length of ${CLI_ARGUMENT_MAX_LENGTH}`),
    );
    expect(() => assertCliArgumentBounds({ note: "n".repeat(CLI_TEXT_ARGUMENT_MAX_LENGTH + 1) }, "options")).toThrow(
      new RegExp(`maximum length of ${CLI_TEXT_ARGUMENT_MAX_LENGTH}`),
    );
    expect(() => assertCliArgumentBounds({ value: "v".repeat(CLI_JSON_ARGUMENT_MAX_BYTES + 1) }, "options")).toThrow(
      new RegExp(`maximum size of ${CLI_JSON_ARGUMENT_MAX_BYTES}`),
    );
  });

  test("recurses through arrays and keeps field-specific limits after array indexes", () => {
    expect(() =>
      assertCliArgumentBounds({ targets: [{ name: "n".repeat(CLI_IDENTIFIER_MAX_LENGTH + 1) }] }, "args"),
    ).toThrow(/args\.targets\[0\]\.name/);
  });

  test("wraps leaf command handlers once, including nested groups, and skips fetch commands", () => {
    const calls = [];
    const leaf = {
      marker: "leaf-this",
      run(context) {
        calls.push(context);
        return this.marker;
      },
    };
    const nested = {
      run() {
        calls.push("nested");
        return "nested-ok";
      },
    };
    const fetch = {
      _fetch: true,
      run() {
        return "fetch-ok";
      },
    };
    const fetchRun = fetch.run;
    const commands = new Map([
      ["leaf", leaf],
      ["group", { _group: true, commands: new Map([["nested", nested]]) }],
      ["fetch", fetch],
    ]);

    wrapCliCommandHandlersWithInputBounds(commands);
    const wrappedLeafRun = leaf.run;
    wrapCliCommandHandlersWithInputBounds(commands);

    expect(leaf.run).toBe(wrappedLeafRun);
    expect(fetch.run).toBe(fetchRun);
    expect(leaf.run({ args: { runId: "run-1" }, options: { prompt: "hello" } })).toBe("leaf-this");
    expect(nested.run({ args: {}, options: { name: "ok" } })).toBe("nested-ok");
    expect(() => leaf.run({ args: { runId: "r".repeat(CLI_IDENTIFIER_MAX_LENGTH + 1) }, options: {} })).toThrow(
      /args\.runId/,
    );
    expect(calls).toHaveLength(2);
    expect(fetch.run()).toBe("fetch-ok");
  });
});
