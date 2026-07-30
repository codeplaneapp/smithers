import { describe, it, expect } from "bun:test";
import { parseKeypress } from "@opentui/core";
import { routeAppKey, type Mode } from "../src/App.tsx";

/**
 * Unit tests for the app-global key contract, driven through the REAL OpenTUI
 * parseKeypress so the events carry exactly the shapes a terminal produces
 * (Ctrl+letter = control byte → plain name + ctrl, Shift+letter = lowercased
 * name + shift, Alt+letter = Esc prefix → meta).
 */

function key(raw: string) {
  const parsed = parseKeypress(Buffer.from(raw));
  if (!parsed) throw new Error(`parseKeypress returned null for ${JSON.stringify(raw)}`);
  return parsed;
}

const inTree = { mode: 1 as Mode, showHelp: false };
const inTimeline = { mode: 4 as Mode, showHelp: false };
const helpOpen = { mode: 1 as Mode, showHelp: true };

describe("routeAppKey – quit contract", () => {
  it("quits on q, Shift+Q and Ctrl-C", () => {
    expect(routeAppKey(key("q"), inTree)).toEqual({ kind: "exit" });
    // Shift+Q arrives as { name: "q", shift: true } — a literal "Q" never occurs.
    expect(key("Q").name).toBe("q");
    expect(routeAppKey(key("Q"), inTree)).toEqual({ kind: "exit" });
    expect(routeAppKey(key("\x03"), inTree)).toEqual({ kind: "exit", code: 130 }); // Ctrl-C
  });

  it("does NOT quit on Ctrl-Q (undocumented chord)", () => {
    const ctrlQ = key("\x11");
    expect(ctrlQ.name).toBe("q");
    expect(ctrlQ.ctrl).toBe(true);
    expect(routeAppKey(ctrlQ, inTree)).toBeNull();
  });
});

describe("routeAppKey – ctrl/meta chords never hit letter bindings", () => {
  it("Ctrl-L (redraw habit) must not switch to Logs", () => {
    const ctrlL = key("\x0c");
    expect(ctrlL.name).toBe("l");
    expect(routeAppKey(ctrlL, inTree)).toBeNull();
  });

  it("Ctrl-T / Ctrl-G / Alt+letters are no-ops", () => {
    expect(routeAppKey(key("\x14"), inTree)).toBeNull(); // Ctrl-T
    expect(routeAppKey(key("\x07"), inTree)).toBeNull(); // Ctrl-G
    expect(routeAppKey(key("\x1bl"), inTree)).toBeNull(); // Alt-L (meta)
    expect(routeAppKey(key("\x1bq"), inTree)).toBeNull(); // Alt-Q (meta)
  });
});

describe("routeAppKey – mode letters and Shift+L", () => {
  it("bare letters switch modes", () => {
    expect(routeAppKey(key("l"), inTree)).toEqual({ kind: "set-mode", mode: 3 });
    expect(routeAppKey(key("t"), inTree)).toEqual({ kind: "set-mode", mode: 4 });
    expect(routeAppKey(key("h"), inTree)).toEqual({ kind: "set-mode", mode: 5 });
    expect(routeAppKey(key("g"), inTree)).toEqual({ kind: "toggle-graph" });
  });

  it("Shift+L is reserved for Timeline's back-to-live — it must NOT switch to Logs", () => {
    // Raw "L" parses as { name: "l", shift: true }: without the shift guard,
    // pressing the Timeline-advertised "[L] back to live" yanked the user into
    // Logs mode and destroyed the scrub position.
    const shiftL = key("L");
    expect(shiftL.name).toBe("l");
    expect(shiftL.shift).toBe(true);
    expect(routeAppKey(shiftL, inTimeline)).toBeNull();
    expect(routeAppKey(shiftL, inTree)).toBeNull();
  });

  it("1-5 switch modes only outside Tree (Tree owns 1-4 for tabs)", () => {
    expect(routeAppKey(key("2"), inTree)).toBeNull();
    expect(routeAppKey(key("1"), inTimeline)).toEqual({ kind: "set-mode", mode: 1 });
    expect(routeAppKey(key("3"), inTimeline)).toEqual({ kind: "set-mode", mode: 3 });
  });
});

describe("routeAppKey – help overlay", () => {
  it("? toggles the overlay from anywhere", () => {
    expect(routeAppKey(key("?"), inTree)).toEqual({ kind: "toggle-help" });
    expect(routeAppKey(key("?"), helpOpen)).toEqual({ kind: "toggle-help" });
  });

  it("q quits WHILE the overlay is open — the overlay advertises it", () => {
    expect(routeAppKey(key("q"), helpOpen)).toEqual({ kind: "exit" });
    expect(routeAppKey(key("\x03"), helpOpen)).toEqual({ kind: "exit", code: 130 }); // Ctrl-C too
  });

  it("Esc closes the overlay; mode keys are swallowed while it is open", () => {
    expect(routeAppKey(key("\x1b"), helpOpen)).toEqual({ kind: "close-help" });
    expect(routeAppKey(key("l"), helpOpen)).toBeNull();
    expect(routeAppKey(key("g"), helpOpen)).toBeNull();
    expect(routeAppKey(key("j"), helpOpen)).toBeNull();
    expect(routeAppKey(key("1"), { ...helpOpen, mode: 4 })).toBeNull();
  });
});

describe("routeAppKey – text capture", () => {
  const captured = { mode: 6 as Mode, showHelp: false, keysCaptured: true };

  it("suppresses quit, help, mode, and digit bindings while a mode captures text", () => {
    for (const raw of ["q", "?", "g", "l", "t", "h", "r", "1", "6"]) {
      expect(routeAppKey(key(raw), captured)).toBeNull();
    }
  });

  it("keeps Ctrl-C as the global escape hatch", () => {
    expect(routeAppKey(key("\x03"), captured)).toEqual({ kind: "exit", code: 130 });
    expect(routeAppKey(key("\x1b"), captured)).toBeNull();
  });
});
