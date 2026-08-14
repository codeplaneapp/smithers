import { describe, expect, test } from "bun:test";
import {
  createHerdrClient,
  createHerdrRunSurface,
  HERDR_PROTOCOL,
  HERDR_SURFACE_EVENT_TYPES,
  HerdrError,
  launchHijackPane,
  normalizeHerdrEventName,
  resolveSocketPath,
  sessionSocketPath,
  shortRunId,
} from "../src/index.js";

describe("package barrel exports", () => {
  test("re-exports the public surface", () => {
    expect(HERDR_PROTOCOL).toBe(19);
    expect(HERDR_SURFACE_EVENT_TYPES instanceof Set).toBe(true);
    expect(HERDR_SURFACE_EVENT_TYPES.has("NodeStarted")).toBe(true);
    expect(typeof createHerdrClient).toBe("function");
    expect(typeof createHerdrRunSurface).toBe("function");
    expect(typeof launchHijackPane).toBe("function");
    expect(typeof shortRunId).toBe("function");
    expect(typeof HerdrError).toBe("function");
    expect(typeof normalizeHerdrEventName).toBe("function");
    expect(typeof resolveSocketPath).toBe("function");
    expect(typeof sessionSocketPath).toBe("function");
  });

  test("shortRunId returns the first 8 chars", () => {
    expect(shortRunId("run-abcdefgh-ijkl")).toBe("run-abcd");
    expect(shortRunId("short")).toBe("short");
    expect(shortRunId(/** @type {any} */ (undefined))).toBe("");
  });

  test("createHerdrRunSurface exposes the surface shape without connecting", () => {
    const surface = createHerdrRunSurface({ client: createHerdrClient({ socketPath: "/tmp/does-not-exist.sock" }) });
    expect(typeof surface.onEvent).toBe("function");
    expect(typeof surface.attach).toBe("function");
    expect(typeof surface.close).toBe("function");
  });

  test("createHerdrClient exposes the client surface without connecting", () => {
    const client = createHerdrClient({ socketPath: "/tmp/does-not-exist.sock" });
    expect(client.socketPath).toBe("/tmp/does-not-exist.sock");
    expect(typeof client.call).toBe("function");
    expect(typeof client.tryCall).toBe("function");
    expect(typeof client.subscribe).toBe("function");
    expect(typeof client.ping).toBe("function");
  });

  test("normalizeHerdrEventName maps snake_case to dotted and leaves dotted names alone", () => {
    expect(normalizeHerdrEventName("workspace_created")).toBe("workspace.created");
    expect(normalizeHerdrEventName("pane_agent_status_changed")).toBe("pane.agent_status_changed");
    expect(normalizeHerdrEventName("pane.agent_status_changed")).toBe("pane.agent_status_changed");
    expect(normalizeHerdrEventName("layout_updated")).toBe("layout.updated");
  });

  test("HerdrError carries method + code", () => {
    const err = new HerdrError("boom", { method: "ping", code: "timeout" });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("HerdrError");
    expect(err.method).toBe("ping");
    expect(err.code).toBe("timeout");
  });
});
