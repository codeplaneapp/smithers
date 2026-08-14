import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveSocketPath, sessionSocketPath } from "../src/resolveSocketPath.js";

const CONFIG = "/home/tester/.config";
const baseEnv = { HOME: "/home/tester", XDG_CONFIG_HOME: CONFIG };

describe("resolveSocketPath precedence", () => {
  test("explicit socketPath wins over everything", () => {
    const env = { ...baseEnv, HERDR_SOCKET_PATH: "/env/sock", HERDR_SESSION: "envsess" };
    expect(resolveSocketPath({ socketPath: "/explicit.sock", session: "opt" }, env)).toBe("/explicit.sock");
  });

  test("session option beats HERDR_SOCKET_PATH and HERDR_SESSION", () => {
    const env = { ...baseEnv, HERDR_SOCKET_PATH: "/env/sock", HERDR_SESSION: "envsess" };
    expect(resolveSocketPath({ session: "opt" }, env)).toBe(join(CONFIG, "herdr", "sessions", "opt", "herdr.sock"));
  });

  test("HERDR_SOCKET_PATH beats HERDR_SESSION", () => {
    const env = { ...baseEnv, HERDR_SOCKET_PATH: "/env/sock", HERDR_SESSION: "envsess" };
    expect(resolveSocketPath({}, env)).toBe("/env/sock");
  });

  test("HERDR_SESSION beats the default when no socket path is set", () => {
    const env = { ...baseEnv, HERDR_SESSION: "envsess" };
    expect(resolveSocketPath({}, env)).toBe(join(CONFIG, "herdr", "sessions", "envsess", "herdr.sock"));
  });

  test("falls back to the default session socket", () => {
    expect(resolveSocketPath({}, { ...baseEnv })).toBe(join(CONFIG, "herdr", "herdr.sock"));
  });

  test("uses the OS home ~/.config when XDG_CONFIG_HOME is unset", () => {
    // herdrConfigDir falls back to os.homedir() (which reflects the real
    // process HOME), not the passed-in env, when XDG_CONFIG_HOME is absent.
    expect(resolveSocketPath({}, {})).toBe(join(homedir(), ".config", "herdr", "herdr.sock"));
  });

  test("sessionSocketPath builds the documented named-session path", () => {
    expect(sessionSocketPath("my-run", baseEnv)).toBe(join(CONFIG, "herdr", "sessions", "my-run", "herdr.sock"));
  });
});
