import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import * as smithers from "smthrs";

const HERE = dirname(fileURLToPath(import.meta.url));

// Guards the programmatic run-control + output-reading API on the public barrel.
// These power embedders that drive durable runs across processes (start a run,
// pause at an <Approval> gate, approve/deny, resume, and read node outputs)
// without reaching into internal @smthrs/* subpackages.
test("public barrel exposes the programmatic run-control + output API", () => {
  const surface = smithers as unknown as Record<string, unknown>;
  for (const name of [
    "runWorkflow",
    "approveNode",
    "denyNode",
    "getRun",
    "listRuns",
    "signalRun",
    "loadOutputs",
    "loadOutputsEffect",
  ]) {
    expect(typeof surface[name]).toBe("function");
  }
});

// Guards that every documented `smthrs/*` facade subpath still
// resolves at runtime with a non-empty export set. Closes the #300 audit item
// "No automated guard that every documented public subpath export resolves":
// most facades resolve purely by file existence through the package.json
// `./*` -> `./src/*.js` wildcard, so a renamed or deleted facade file breaks a
// documented import today with no other CI signal.
test("documented smthrs subpaths resolve", async () => {
  // Explicit (non-wildcard) export keys are derived from the published package's
  // exports map, so a newly added explicit facade (as `telegram` and
  // `cloudflare` recently were) is covered automatically without editing this
  // test.
  const facadeExports = JSON.parse(
    readFileSync(join(HERE, "../../packages/smithers/package.json"), "utf8"),
  ).exports as Record<string, unknown>;
  const explicitSubpaths = Object.keys(facadeExports)
    .filter((key) => key.startsWith("./") && !key.includes("*"))
    .map((key) => `smthrs/${key.slice("./".length)}`);

  // Documented subpaths that resolve only through the `./*` wildcard (by file
  // existence), so they cannot be enumerated from the exports map and stay a
  // curated list. Keep in sync with docs/ when a wildcard-backed facade is
  // documented.
  const wildcardBackedSubpaths = [
    "smthrs/dom/renderer",
    "smthrs/gateway",
    "smthrs/mdx-plugin",
    "smthrs/memory",
    "smthrs/observability",
    "smthrs/openapi",
    "smthrs/scorers",
    "smthrs/serve",
    "smthrs/server",
  ];

  const documentedSubpaths = [
    ...new Set([...explicitSubpaths, ...wildcardBackedSubpaths]),
  ].sort();

  for (const specifier of documentedSubpaths) {
    const mod = await import(specifier);
    expect(Object.keys(mod), specifier).not.toHaveLength(0);
  }
});
