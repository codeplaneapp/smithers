import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bundleGatewayUiEntry } from "../src/gatewayUi/bundle.js";

/**
 * Regression coverage for the react peer dedupe plugin.
 *
 * The gateway bundles `.smithers/ui/<wf>.tsx` from the CONSUMER workspace, so
 * bare `react` / `react-dom` imports resolve to the consumer's node_modules by
 * default. react-dom hard-requires a version-matched react, and the server pins
 * `react` to its own copy -- so `react-dom` MUST be pinned too or any UI that
 * imports it (portals in shared components, `flushSync`, `createRoot`) mixes
 * React copies under consumer version skew and crashes with invalid-hook-call.
 * The old regex `/^react(?:\/.*)?$/` missed react-dom; this locks the fix in.
 */
describe("gateway UI bundle react dedupe", () => {
  let tempDir;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  /**
   * @param {string} dir
   * @param {string} name
   * @param {string} marker
   */
  function writeConsumerCopy(dir, name, marker) {
    const packageDir = join(dir, "node_modules", name);
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(
      join(packageDir, "package.json"),
      JSON.stringify({ name, version: "0.0.0-consumer", type: "module", main: "index.js" }),
    );
    writeFileSync(
      join(packageDir, "index.js"),
      `export const MARKER = ${JSON.stringify(marker)};\nexport default { MARKER };\n`,
    );
  }

  test("pins react AND react-dom to the server's copy over consumer-local copies", async () => {
    // A consumer workspace shape: its own node_modules carries react and
    // react-dom copies that must NOT reach the bundle.
    tempDir = mkdtempSync(join(process.cwd(), ".smithers-ui-dedupe-"));
    writeConsumerCopy(tempDir, "react", "CONSUMER_REACT_COPY");
    writeConsumerCopy(tempDir, "react-dom", "CONSUMER_REACT_DOM_COPY");

    const entry = join(tempDir, "entry.tsx");
    writeFileSync(
      entry,
      [
        'import React from "react";',
        'import ReactDOM from "react-dom";',
        'import { createRoot } from "react-dom/client";',
        "console.log(React, ReactDOM, createRoot);",
        "",
      ].join("\n"),
    );

    const body = await bundleGatewayUiEntry({ entry }, new Map());

    // Without the dedupe covering react-dom, the consumer markers leak into
    // the bundle (or the build fails on the consumer copy's missing subpaths).
    expect(body).not.toContain("CONSUMER_REACT_COPY");
    expect(body).not.toContain("CONSUMER_REACT_DOM_COPY");
    // Sanity: the real (server-resolved) copies were bundled instead.
    expect(body).toContain("react-dom");
  });

  test("defines process.env.NODE_ENV=production in served UI bundles", async () => {
    // The default (cached) serving path bundles production React for the size
    // win; a refactor of the Bun.build define could silently drop it. Pin it.
    tempDir = mkdtempSync(join(process.cwd(), ".smithers-ui-nodeenv-"));
    const entry = join(tempDir, "entry.tsx");
    writeFileSync(entry, "console.log(process.env.NODE_ENV);\n");

    const body = await bundleGatewayUiEntry({ entry }, new Map());

    expect(body).toContain('console.log("production")');
    expect(body).not.toContain('console.log("development")');
    expect(body).not.toContain("sourceMappingURL=data:");
  });
});
