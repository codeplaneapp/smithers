import { describe, expect, test } from "bun:test";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isSystemWorkflowSource, normalizeHerdrCockpitOpts } from "../src/herdr.js";

describe("normalizeHerdrCockpitOpts", () => {
  test("empty / invalid", () => {
    expect(normalizeHerdrCockpitOpts(undefined)).toEqual({});
    expect(normalizeHerdrCockpitOpts(null)).toEqual({});
    expect(normalizeHerdrCockpitOpts("x")).toEqual({});
  });

  test("extracts declarative cockpit fields", () => {
    const out = normalizeHerdrCockpitOpts({
      pin: ["merge-queue", 12, "*:final"],
      softPinSlots: 2.7,
      tabCap: 8,
      autoOpen: { workers: true },
      sessionName: "mission-auth",
      surface: "session",
      chrome: "split",
      harnessCommand: "auto",
      dock: false,
      noise: true,
    });
    expect(out.pin).toEqual(["merge-queue", "*:final"]);
    expect(out.softPinSlots).toBe(2.7);
    expect(out.tabCap).toBe(8);
    expect(out.autoOpen).toEqual({ workers: true });
    expect(out.sessionName).toBe("mission-auth");
    expect(out.surface).toBe("session");
    expect(out.chrome).toBe("split");
    expect(out.harnessCommand).toBe("auto");
    expect(out.dock).toBe(false);
    expect(/** @type {any} */ (out).noise).toBeUndefined();
  });
});

describe("isSystemWorkflowSource", () => {
  test("detects smithers-system frontmatter", () => {
    const dir = join(tmpdir(), `smithers-sys-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "post-failure.tsx");
    writeFileSync(path, `// smithers-system: true\nexport default {}\n`);
    expect(isSystemWorkflowSource(path)).toBe(true);
    const path2 = join(dir, "hello.tsx");
    writeFileSync(path2, `export default {}\n`);
    expect(isSystemWorkflowSource(path2)).toBe(false);
  });
});
