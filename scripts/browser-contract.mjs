/**
 * The browser contract, declared.
 *
 * Two lists and nothing else: the entry points the repository promises bundle
 * for a browser, and the ones it documents as Node-only with the `node:`
 * built-in that keeps them there. `scripts/browser-check.mjs` executes the
 * promise with esbuild; `scripts/check-docs.mjs` reads the same declaration and
 * fails when a page states a different set or a different count. They share
 * this module so the prose and the gate cannot drift apart.
 */

/**
 * Entry points that are part of the browser promise. Each is bundled for the
 * browser; any resolution or syntax error fails the gate.
 */
export const BROWSER_SAFE = [
  { name: "@smthrs/artifacts", entry: "packages/artifacts/src/index.ts" },
  { name: "@smthrs/canonical", entry: "packages/canonical/src/index.ts" },
  { name: "@smthrs/capability", entry: "packages/capability/src/index.ts" },
  { name: "@smthrs/chain", entry: "packages/chain/src/index.ts" },
  { name: "@smthrs/crypto", entry: "packages/crypto/src/index.ts" },
  { name: "@smthrs/jj", entry: "packages/jj/src/index.ts" },
  { name: "@smthrs/jj/browser/BrowserJj", entry: "packages/jj/src/browser/BrowserJj.ts" },
  { name: "@smthrs/platform-browser", entry: "packages/platform-browser/src/index.ts" },
  {
    name: "@smthrs/platform-browser/BrowserHost",
    entry: "packages/platform-browser/src/BrowserHost.ts"
  },
  { name: "@smthrs/sandbox", entry: "packages/sandbox/src/index.ts" },
  { name: "@smthrs/kernel", entry: "packages/kernel/src/index.ts" },
  { name: "@smthrs/keys", entry: "packages/keys/src/index.ts" },
  { name: "@smthrs/plan", entry: "packages/plan/src/index.ts" },
  { name: "@smthrs/database", entry: "packages/database/src/index.ts" },
  { name: "@smthrs/journal", entry: "packages/journal/src/index.ts" },
  { name: "@smthrs/run-store", entry: "packages/run-store/src/index.ts" },
  { name: "@smthrs/step-cache", entry: "packages/step-cache/src/index.ts" },
  { name: "@smthrs/flow", entry: "packages/flow/src/index.ts" },
  { name: "@smthrs/engine", entry: "packages/engine/src/index.ts" },
  { name: "@smthrs/engine-store", entry: "packages/engine-store/src/index.ts" },
  { name: "@smthrs/flows", entry: "packages/flows/src/index.ts" },
  { name: "@smthrs/observability", entry: "packages/observability/src/index.ts" },
  { name: "@smthrs/sync", entry: "packages/sync/src/index.ts" },
  { name: "@smthrs/time-travel", entry: "packages/time-travel/src/index.ts" },
  { name: "@smthrs/std/Grep", entry: "packages/std/src/Grep.ts" },
  { name: "@smthrs/std/Glob", entry: "packages/std/src/Glob.ts" },
  { name: "@smthrs/std/Search", entry: "packages/std/src/Search.ts" },
  { name: "@smthrs/std/PortableSearch", entry: "packages/std/src/PortableSearch.ts" }
]

/**
 * Entry points documented as Node-only. The `expect` module is the `node:`
 * built-in the documentation names as the reason; if an entry stops failing —
 * or starts failing for some other reason — the docs and this list are wrong.
 */
export const NODE_ONLY = [
  {
    name: "@smthrs/platform-node",
    entry: "packages/platform-node/src/index.ts",
    expect: "node:child_process",
    reason: "the Node host bundle spawns child processes"
  },
  {
    name: "@smthrs/platform-bun",
    entry: "packages/platform-bun/src/index.ts",
    expect: "node:fs",
    reason: "the Bun bundle falls back to the @effect/platform-node adapters off Bun"
  },
  {
    name: "@smthrs/kernel/test/TestHost",
    entry: "packages/kernel/src/test/TestHost.ts",
    expect: "node:assert",
    reason: "effect/testing's TestClock pulls node:assert"
  },
  {
    name: "@smthrs/jj/node/NodeJj",
    entry: "packages/jj/src/node/NodeJj.ts",
    expect: "node:child_process",
    reason: "the Node jj adapter spawns the jj CLI"
  },
  {
    name: "@smthrs/jj/bun/BunJj",
    entry: "packages/jj/src/bun/BunJj.ts",
    expect: "node:child_process",
    reason: "the Bun jj adapter reuses the Node child-process implementation"
  },
  {
    name: "@smthrs/database/node/NodeDatabase",
    entry: "packages/database/src/node/NodeDatabase.ts",
    expect: "node:sqlite",
    reason: "the Node database layer is node:sqlite through @effect/sql-sqlite-node"
  },
  {
    name: "@smthrs/flows/NodeRuntime",
    entry: "packages/flows/src/NodeRuntime.ts",
    expect: "node:sqlite",
    reason: "the supported production composition opens the database through NodeDatabase"
  }
]

/** The names in the browser half of the contract. */
export const browserEntryNames = () => BROWSER_SAFE.map((entry) => entry.name)

/** The names in the Node-only half of the contract. */
export const nodeEntryNames = () => NODE_ONLY.map((entry) => entry.name)

/**
 * Every place a document states how many entry points bundle for the browser.
 *
 * The count moves whenever an entry point joins or leaves `BROWSER_SAFE`, and a
 * number written by hand goes stale silently: the gate keeps passing while the
 * page lies. Both spellings this tree uses are read.
 *
 * @example
 * ```js
 * citedBrowserCounts("28 entry points bundle for the browser.") // [28]
 * ```
 */
export const citedBrowserCounts = (body) =>
  [
    ...body.matchAll(/(\d+) entry points bundle for the browser/g),
    ...body.matchAll(/(\d+) browser entry points/g)
  ].map((match) => Number(match[1]))
