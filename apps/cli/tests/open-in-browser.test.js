// Unit coverage for the browser-launch gate. The per-command `--open/--no-open`
// flag is per-invocation, so it cannot help when an AGENT runs `smithers
// monitor`/`ui`/`gui` on your behalf: these env rules are the deterministic
// mechanism. `shouldOpenBrowser` is pure (env in, boolean out), so every rule is
// asserted without ever spawning a launcher.
import { describe, expect, test } from "bun:test";
import { openInBrowser, shouldOpenBrowser } from "../src/openInBrowser.js";

describe("shouldOpenBrowser", () => {
  test("opens by default in a plain terminal", () => {
    expect(shouldOpenBrowser({})).toBe(true);
  });

  test("SMITHERS_NO_BROWSER=1/true suppresses anywhere (plain tmux split, SSH, CI)", () => {
    expect(shouldOpenBrowser({ SMITHERS_NO_BROWSER: "1" })).toBe(false);
    expect(shouldOpenBrowser({ SMITHERS_NO_BROWSER: "true" })).toBe(false);
  });

  test("HERDR_ENV=1 suppresses: the operator already has a terminal cockpit", () => {
    expect(shouldOpenBrowser({ HERDR_ENV: "1" })).toBe(false);
  });

  test("SMITHERS_NO_BROWSER=0/false forces open even inside herdr", () => {
    // The explicit force-open escape hatch: `--open` defaults to true, so an
    // explicitly-typed --open is indistinguishable from "not passed" — the env
    // var is the only way to override the herdr auto-suppression.
    expect(shouldOpenBrowser({ HERDR_ENV: "1", SMITHERS_NO_BROWSER: "0" })).toBe(true);
    expect(shouldOpenBrowser({ HERDR_ENV: "1", SMITHERS_NO_BROWSER: "false" })).toBe(true);
  });

  test("SMITHERS_NO_BROWSER wins over HERDR_ENV in both directions", () => {
    expect(shouldOpenBrowser({ HERDR_ENV: "1", SMITHERS_NO_BROWSER: "1" })).toBe(false);
    expect(shouldOpenBrowser({ HERDR_ENV: "0", SMITHERS_NO_BROWSER: "1" })).toBe(false);
  });

  test("an unrelated/garbage SMITHERS_NO_BROWSER value falls through to the auto rules", () => {
    // Only the documented literals are honored; anything else must not silently
    // read as "suppress" (a typo should not disable the browser everywhere).
    expect(shouldOpenBrowser({ SMITHERS_NO_BROWSER: "yes" })).toBe(true);
    expect(shouldOpenBrowser({ SMITHERS_NO_BROWSER: "" })).toBe(true);
    expect(shouldOpenBrowser({ SMITHERS_NO_BROWSER: "yes", HERDR_ENV: "1" })).toBe(false);
  });

  test('HERDR_ENV values other than exactly "1" do not suppress', () => {
    // herdr e2e/scripted paths deliberately set HERDR_ENV=0 to opt out.
    expect(shouldOpenBrowser({ HERDR_ENV: "0" })).toBe(true);
    expect(shouldOpenBrowser({ HERDR_ENV: "true" })).toBe(true);
  });
});

describe("openInBrowser", () => {
  test("returns false WITHOUT spawning when the environment suppresses it", () => {
    // No launcher process is created: the callers print the URL on a false
    // return, so suppression degrades to a copyable link, never a silent no-op.
    expect(openInBrowser("http://127.0.0.1:7331/monitor", { HERDR_ENV: "1" })).toBe(false);
    expect(openInBrowser("http://127.0.0.1:7331/monitor", { SMITHERS_NO_BROWSER: "1" })).toBe(false);
  });
});
