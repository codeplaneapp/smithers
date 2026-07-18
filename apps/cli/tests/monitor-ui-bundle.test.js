import { expect, test } from "bun:test";
import { bundleGatewayUiEntry } from "../../../packages/server/src/gatewayUi/bundle.js";

test("monitor entry bundles monitor and xterm styles", async () => {
  const bundle = await bundleGatewayUiEntry({
    entry: new URL("../src/monitor-ui/monitor.tsx", import.meta.url).pathname,
  }, new Map());
  const text = typeof bundle === "string" ? bundle : bundle.contents?.toString() ?? bundle.js ?? "";
  expect(text.length).toBeGreaterThan(0);
  expect(text).toContain(".mon-shell");
  expect(text).toContain(".xterm");
  expect(text).not.toMatch(/from\s+["']@xterm\/xterm\/css\/xterm\.css/);
  // Parsing the final bundle catches dangling export aliases that Bun.build
  // can otherwise return as a successful but browser-invalid client module.
  const parsed = new Bun.Transpiler({ loader: "js" }).transformSync(text);
  expect(parsed.length).toBeGreaterThan(0);
});
