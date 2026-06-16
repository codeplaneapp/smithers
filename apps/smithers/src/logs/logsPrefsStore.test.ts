import { beforeEach, describe, expect, test } from "bun:test";
import { useLogsPrefsStore } from "./logsPrefsStore";

/**
 * The logs toolbar toggle store. The defaults matter: `redact` ships on so
 * secrets stay masked until a reader opts out, and `follow` ships on so the
 * stream stays pinned to the tail. Toggles must be pure flips — the canvas
 * binds raw selectors against them.
 */

const INITIAL = {
  follow: true,
  hideNoise: false,
  redact: true,
};

beforeEach(() => {
  useLogsPrefsStore.setState(INITIAL);
});

describe("logs prefs defaults", () => {
  test("follow is on", () => {
    expect(useLogsPrefsStore.getState().follow).toBe(true);
  });

  test("hideNoise is off", () => {
    expect(useLogsPrefsStore.getState().hideNoise).toBe(false);
  });

  test("redact is on so secrets stay masked by default", () => {
    expect(useLogsPrefsStore.getState().redact).toBe(true);
  });
});

describe("logs prefs toggles", () => {
  test("toggleFollow flips follow and only follow", () => {
    const before = useLogsPrefsStore.getState();
    before.toggleFollow();
    const after = useLogsPrefsStore.getState();
    expect(after.follow).toBe(!before.follow);
    expect(after.hideNoise).toBe(before.hideNoise);
    expect(after.redact).toBe(before.redact);
  });

  test("toggleHideNoise flips hideNoise and only hideNoise", () => {
    const before = useLogsPrefsStore.getState();
    before.toggleHideNoise();
    const after = useLogsPrefsStore.getState();
    expect(after.hideNoise).toBe(!before.hideNoise);
    expect(after.follow).toBe(before.follow);
    expect(after.redact).toBe(before.redact);
  });

  test("toggleRedact flips redact and only redact", () => {
    const before = useLogsPrefsStore.getState();
    before.toggleRedact();
    const after = useLogsPrefsStore.getState();
    expect(after.redact).toBe(!before.redact);
    expect(after.follow).toBe(before.follow);
    expect(after.hideNoise).toBe(before.hideNoise);
  });

  test("toggling twice returns to the original value", () => {
    const { toggleFollow, toggleHideNoise, toggleRedact } =
      useLogsPrefsStore.getState();
    toggleFollow();
    toggleFollow();
    toggleHideNoise();
    toggleHideNoise();
    toggleRedact();
    toggleRedact();
    expect(useLogsPrefsStore.getState()).toMatchObject(INITIAL);
  });
});
