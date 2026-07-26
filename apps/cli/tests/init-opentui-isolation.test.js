import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(fileURLToPath(import.meta.url), "../../src");

// A static ESM import of the OpenTUI native binding on the eager CLI startup
// path (initCeremony.js → init-command.js → index.js) makes EVERY smithers
// command crash on a platform where the dylib fails to dlopen — the shipped
// regression fixed in e58a8e59af. Init's interactive surface is clack-only
// now (the OpenTUI multiselect wizard was removed when init became a single
// agent question), so nothing on this chain may import @opentui at all.
const STARTUP_MODULES = [
  "init/interactiveInit.tsx",
  "init/selectPreferredAgent.js",
  "init/installAgentIntegration.js",
  "initCeremony.js",
  "init-command.js",
];

test("no static @opentui import on the eager CLI startup path", () => {
  for (const rel of STARTUP_MODULES) {
    const src = readFileSync(resolve(SRC, rel), "utf8");
    // Matches `from "@opentui...` / `from '@opentui...`, which excludes
    // type-position `typeof import("...")` annotations (erased at compile
    // time) — those are harmless.
    expect(src).not.toMatch(/from\s+["']@opentui/);
  }
});
