import { describe, expect, test } from "bun:test";
import * as barrel from "../src/index";
import * as styles from "../src/styles";

// Components call this hook internally. It is not a consumer styling API.
const INTENTIONALLY_INTERNAL_STYLE_EXPORTS = new Set(["useInjectUiCss"]);

describe("styles barrel reachability", () => {
  test("forwards every consumer-facing styles value from the package barrel", () => {
    const missing = Object.keys(styles)
      .filter((name) => !INTENTIONALLY_INTERNAL_STYLE_EXPORTS.has(name) && !(name in barrel))
      .sort();
    expect(missing).toEqual([]);
  });

  test("keeps the internal allowlist explicit and narrow", () => {
    expect([...INTENTIONALLY_INTERNAL_STYLE_EXPORTS]).toEqual(["useInjectUiCss"]);
    expect("useInjectUiCss" in styles).toBe(true);
    expect("useInjectUiCss" in barrel).toBe(false);
  });
});
