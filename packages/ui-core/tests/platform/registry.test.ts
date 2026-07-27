import { afterEach, describe, expect, test } from "bun:test";
import { getPlatform, resetPlatformForTests, setPlatform } from "../../src/platform/registry.ts";
import type { Platform } from "../../src/platform/types.ts";

function fakePlatform(): Platform {
  return {
    storage: { get: () => null, set: () => {}, remove: () => {} },
    clipboard: { copy: async () => ({ ok: false, reason: "unavailable" }) },
    openExternal: {
      openUrl: async () => ({ ok: false, reason: "unavailable" }),
      saveFile: async () => ({ ok: false, reason: "unavailable" }),
    },
    notify: { notify: () => {} },
    navigation: {
      openSurface: () => {},
      back: () => {},
      forward: () => {},
      current: () => ({ surface: "home" }),
    },
    focus: { isFocused: () => true, isVisible: () => true, subscribe: () => () => {} },
    viewport: { size: () => ({ cols: 80, rows: 24 }), compact: () => false, subscribe: () => () => {} },
    auth: { principal: () => null, subscribe: () => () => {} },
    persistence: { load: async () => null, save: async () => {}, remove: async () => {} },
  };
}

describe("platform registry", () => {
  afterEach(() => {
    resetPlatformForTests();
  });

  test("throws before a platform is set", () => {
    expect(() => getPlatform()).toThrow(/Platform not set/);
  });

  test("returns exactly the platform passed to setPlatform", () => {
    const platform = fakePlatform();
    setPlatform(platform);
    expect(getPlatform()).toBe(platform);
  });

  test("resetPlatformForTests clears the singleton", () => {
    setPlatform(fakePlatform());
    resetPlatformForTests();
    expect(() => getPlatform()).toThrow(/Platform not set/);
  });
});
