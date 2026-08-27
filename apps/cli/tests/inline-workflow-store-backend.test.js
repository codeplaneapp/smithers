import { expect, onTestFinished, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { openInlineWorkflowStore } from "../src/openInlineWorkflowStore.js";

/**
 * Inline workflows (the machinery behind `smithers chat-create`) are sqlite-only.
 * The refusal used to read `.smithers/migrated.json` directly, which outranked
 * every operator pin: once a workspace had been migrated to pglite, inline
 * workflows could never run there again, and neither `SMITHERS_BACKEND=sqlite` nor a
 * `backend` field in smithers.config.ts could talk it out of that. These tests
 * pin the precedence the shared resolver defines.
 */

const SCHEMAS = { thing: z.object({ a: z.string() }) };

/** @param {string} label */
function workspace(label) {
  const dir = mkdtempSync(join(tmpdir(), `inline-store-${label}-`));
  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  mkdirSync(join(dir, ".smithers"), { recursive: true });
  return dir;
}

/** @param {string} dir @param {string} backend */
function writeMigratedMarker(dir, backend) {
  writeFileSync(join(dir, ".smithers", "migrated.json"), JSON.stringify({ target: { backend } }));
}

/** Set an env var for one test and restore whatever was there. */
function withEnv(key, value) {
  const previous = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  onTestFinished(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  });
}

test("a sqlite workspace opens", async () => {
  const dir = workspace("plain");
  withEnv("SMITHERS_BACKEND", undefined);

  const store = await openInlineWorkflowStore(dir, SCHEMAS);

  expect(store.db).toBeTruthy();
  expect(store.schemaRegistry.get("thing")).toBeTruthy();
});

test("a pglite marker with no operator pin still refuses, and names every way to pin sqlite", async () => {
  const dir = workspace("pglite");
  writeMigratedMarker(dir, "pglite");
  withEnv("SMITHERS_BACKEND", undefined);

  const error = await openInlineWorkflowStore(dir, SCHEMAS).catch((err) => err);

  expect(error?.code).toBe("BACKEND_MISMATCH");
  expect(error.message).toContain("pglite");
  expect(error.message).toContain("SMITHERS_BACKEND=sqlite");
  expect(error.message).toContain("smithers.config.ts");
  expect(error.message).toContain("backend.json");
});

test("SMITHERS_BACKEND=sqlite outranks a pglite migrated.json (regression)", async () => {
  const dir = workspace("env-pin");
  writeMigratedMarker(dir, "pglite");
  withEnv("SMITHERS_BACKEND", "sqlite");

  const store = await openInlineWorkflowStore(dir, SCHEMAS);

  expect(store.db).toBeTruthy();
});

test("a smithers.config.ts sqlite pin outranks a pglite migrated.json (regression)", async () => {
  const dir = workspace("config-pin");
  writeMigratedMarker(dir, "pglite");
  writeFileSync(join(dir, ".smithers", "smithers.config.ts"), `export default { backend: "sqlite" };\n`);
  withEnv("SMITHERS_BACKEND", undefined);

  const store = await openInlineWorkflowStore(dir, SCHEMAS);

  expect(store.db).toBeTruthy();
});

test("a backend.json sqlite pin outranks a pglite migrated.json", async () => {
  const dir = workspace("marker-pin");
  writeMigratedMarker(dir, "pglite");
  writeFileSync(join(dir, ".smithers", "backend.json"), JSON.stringify({ backend: "sqlite" }));
  withEnv("SMITHERS_BACKEND", undefined);

  const store = await openInlineWorkflowStore(dir, SCHEMAS);

  expect(store.db).toBeTruthy();
});

test("an explicit pglite pin refuses even when no marker exists", async () => {
  const dir = workspace("env-pglite");
  withEnv("SMITHERS_BACKEND", "pglite");

  const error = await openInlineWorkflowStore(dir, SCHEMAS).catch((err) => err);

  expect(error?.code).toBe("BACKEND_MISMATCH");
  expect(error.message).toContain("selected by env");
});
