/** @jsxImportSource smthrs */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { createSmithers } from "smthrs";
import { Gateway } from "../src/gateway.js";

/**
 * Live end-to-end proof for the shared component library
 * (@smthrs/ui) through the REAL gateway pipeline: a workflow UI
 * entry that imports the package is bundled by Bun.build (react + react-dom
 * deduped to the server's copy), served as client.js, and the host page
 * carries the theme system that makes the sui-* classes correct in light AND
 * dark (including the ?theme= data-theme override).
 */
function getPort(server) {
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Gateway server did not expose a port");
  }
  return addr.port;
}

function createValueWorkflow(dbPath) {
  const { smithers, Workflow, Task, outputs } = createSmithers({ result: z.object({ ok: z.boolean() }) }, { dbPath });
  return smithers(() => (
    <Workflow name="shared-components-ui-test">
      <Task id="task1" output={outputs.result}>
        {{ ok: true }}
      </Task>
    </Workflow>
  ));
}

/** A UI entry using the shared library, including a react-dom portal (Dialog). */
function writeSharedComponentsUiEntry(dir) {
  const entry = join(dir, "ui.jsx");
  writeFileSync(
    entry,
    [
      'import { createElement as h } from "react";',
      'import { createRoot } from "react-dom/client";',
      "import {",
      "  Button,",
      "  Card,",
      "  CardHeader,",
      "  CardTitle,",
      "  Dialog,",
      "  DialogContent,",
      "  DialogTitle,",
      "  DialogTrigger,",
      "  SmithersUiStyles,",
      "  StatusPill,",
      '} from "@smthrs/ui";',
      "",
      "function App() {",
      '  return h("main", null,',
      "    h(SmithersUiStyles, null),",
      "    h(Card, null,",
      '      h(CardHeader, null, h(CardTitle, null, "Shared components")),',
      '      h(StatusPill, { status: "running" }),',
      "      h(Dialog, null,",
      '        h(DialogTrigger, { asChild: true }, h(Button, null, "Open")),',
      '        h(DialogContent, null, h(DialogTitle, null, "Portal content")),',
      "      ),",
      "    ),",
      "  );",
      "}",
      'createRoot(document.getElementById("root")).render(h(App));',
    ].join("\n"),
  );
  return entry;
}

/** A source-shipping UI that traverses wildcard gateway package exports. */
function writeGatewaySourceGraphUiEntry(dir) {
  const entry = join(dir, "gateway-source-graph.jsx");
  writeFileSync(
    entry,
    [
      'import { createElement as h } from "react";',
      'import { createRoot } from "react-dom/client";',
      'import { createGatewayReactRoot } from "smthrs/gateway-react";',
      'import { useGatewayActions } from "@smthrs/gateway-react/useGatewayActions";',
      'import { GatewayRpcError } from "@smthrs/gateway-client/rpc";',
      "const graph = [createGatewayReactRoot, useGatewayActions, GatewayRpcError]",
      '  .map((value) => value.name).join(":");',
      'createRoot(document.getElementById("root")).render(',
      '  h("main", { "data-gateway-source-graph": graph }, "Gateway source graph"),',
      ");",
    ].join("\n"),
  );
  return entry;
}

describe("Gateway UI with shared components", () => {
  let gateway;
  let tempDir;

  afterEach(async () => {
    if (gateway) {
      await gateway.close();
      gateway = undefined;
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  test("serves a themed host page and a bundle carrying the sui-* token-driven styles", async () => {
    tempDir = mkdtempSync(join(process.cwd(), ".smithers-shared-ui-"));
    const entry = writeSharedComponentsUiEntry(tempDir);
    gateway = new Gateway();
    gateway.register("shared", createValueWorkflow(join(tempDir, "shared.db")), {
      ui: { entry, title: "Shared Components" },
    });
    const server = await gateway.listen({ port: 0, host: "127.0.0.1" });
    const port = getPort(server);

    // The host page is theme-complete in BOTH forced themes: light tokens,
    // the OS dark branch, the explicit data-theme override, and the pre-paint
    // bootstrap that stamps data-theme from ?theme=.
    for (const themeParam of ["light", "dark"]) {
      const htmlResponse = await fetch(`http://127.0.0.1:${port}/workflows/shared?theme=${themeParam}`);
      expect(htmlResponse.status).toBe(200);
      const html = await htmlResponse.text();
      expect(html).toContain("color-scheme:light");
      expect(html).toContain("--bg:#fafafa");
      expect(html).toContain("@media (prefers-color-scheme: dark)");
      expect(html).toContain(":root[data-theme='dark']");
      expect(html).toContain("--bg:#09090b");
      expect(html).toContain('new URLSearchParams(location.search).get("theme")');
      expect(html).toContain('new URLSearchParams(location.search).get("palette")');
      expect(html).toContain("document.documentElement.dataset.theme=t");
    }

    // The real Bun.build bundle carries the component sheet: namespaced
    // classes, colors resolved through the styleguide tokens with light
    // fallbacks, srgb tints, and the injection marker. react-dom (Dialog
    // portal) bundles without mixed-copy resolution errors.
    const bundleResponse = await fetch(`http://127.0.0.1:${port}/workflows/shared/__smithers_ui/client.js`);
    expect(bundleResponse.status).toBe(200);
    const bundle = await bundleResponse.text();
    expect(bundle).toContain(".sui-button");
    expect(bundle).toContain(".sui-card");
    expect(bundle).toContain(".sui-dialog-content");
    expect(bundle).toContain("color-mix(in srgb, var(--brand, #8f46b5)");
    expect(bundle).toContain("var(--surface, #f6f6f7)");
    expect(bundle).toContain("data-smithers-ui");
    // Note: the component sheet itself carries no dark values (enforced by the
    // ui package's css-contract test); dark comes from the host page flipping
    // the tokens. The bundle DOES carry workflowUiThemeCss for the
    // SmithersUiStyles withTheme standalone path, which is expected.
  }, 20000);

  test("serves the source-shipping gateway-react and gateway-client graph as JavaScript", async () => {
    tempDir = mkdtempSync(join(process.cwd(), ".smithers-gateway-source-ui-"));
    const entry = writeGatewaySourceGraphUiEntry(tempDir);
    gateway = new Gateway();
    gateway.register("source-graph", createValueWorkflow(join(tempDir, "source-graph.db")), {
      ui: { entry, title: "Gateway Source Graph" },
    });
    const server = await gateway.listen({ port: 0, host: "127.0.0.1" });
    const port = getPort(server);

    const response = await fetch(`http://127.0.0.1:${port}/workflows/source-graph/__smithers_ui/client.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type") ?? "").toContain("javascript");
    expect(await response.text()).toContain("data-gateway-source-graph");
  }, 20000);
});
