import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  collectContractErrors,
  DEFAULT_ROOT,
  verifyPinnedUpstream,
} from "./check-codeql-contract.mjs";

const read = (rel) => readFileSync(resolve(DEFAULT_ROOT, rel), "utf8");

test("the checked-in CodeQL replacement contract is internally consistent", () => {
  assert.deepEqual(collectContractErrors({ requireSourceBoundaries: false }), []);
});

test("action and bundle pin drift is rejected", () => {
  const rel = ".github/workflows/codeql.yml";
  const changed = read(rel).replace(
    "99df26d4f13ea111d4ec1a7dddef6063f76b97e9",
    "0000000000000000000000000000000000000000",
  );
  const errors = collectContractErrors({
    requireSourceBoundaries: false,
    overrides: new Map([[rel, changed]]),
  });
  assert.match(errors.join("\n"), /must pin action commit/);
});

test("an extra sanitizer constructor or path is rejected", () => {
  const rel = ".github/codeql/queries/src/SmithersFileAccessToHttp.ql";
  const changed = `${read(rel)}\ncall.getCalleeName() = "unreviewedBoundary" and\ncall.getFile().getRelativePath() = "apps/review/unreviewed.ts"\n`;
  const errors = collectContractErrors({
    requireSourceBoundaries: false,
    overrides: new Map([[rel, changed]]),
  });
  assert.match(errors.join("\n"), /sanitizer must contain only the exact/);
});

test("removing an upstream exclusion is rejected", () => {
  const rel = ".github/codeql/codeql-config.yml";
  const changed = read(rel).replace("      id: js/http-to-file-access\n", "");
  const errors = collectContractErrors({
    requireSourceBoundaries: false,
    overrides: new Map([[rel, changed]]),
  });
  assert.match(errors.join("\n"), /must exclude exactly/);
});

test("an extra ignored source path is rejected", () => {
  const rel = ".github/codeql/codeql-config.yml";
  const changed = read(rel).replace(
    "  - .github/codeql/queries/test/**\n",
    "  - .github/codeql/queries/test/**\n  - apps/review/**\n",
  );
  const errors = collectContractErrors({
    requireSourceBoundaries: false,
    overrides: new Map([[rel, changed]]),
  });
  assert.match(errors.join("\n"), /only the intentionally vulnerable query-test fixtures may be ignored/);
});

test("raw positive alert coverage cannot be removed", () => {
  const rel = ".github/codeql/queries/test/http-to-file-access/SmithersHttpToFileAccess.js";
  const changed = read(rel).replace("// $ Alert[smithers/js-http-to-file-access]", "");
  const errors = collectContractErrors({
    requireSourceBoundaries: false,
    overrides: new Map([[rel, changed]]),
  });
  assert.match(errors.join("\n"), /exactly one raw positive alert expectation/);
});

test("learned inline expectation failures are rejected", () => {
  const rel = ".github/codeql/queries/test/file-access-to-http/SmithersFileAccessToHttp.expected";
  const changed = `${read(rel)}\ntestFailures\n| fixture.js:1:1:1:1 | failure | Missing result |\n`;
  const errors = collectContractErrors({
    requireSourceBoundaries: false,
    overrides: new Map([[rel, changed]]),
  });
  assert.match(errors.join("\n"), /inline expectation failures must never be learned/);
});

test("expected output must contain exactly one positive result", () => {
  const rel = ".github/codeql/queries/test/file-access-to-http/SmithersFileAccessToHttp.expected";
  const changed = read(rel).replace("#select\n", "#select\n| duplicate result |\n");
  const errors = collectContractErrors({
    requireSourceBoundaries: false,
    overrides: new Map([[rel, changed]]),
  });
  assert.match(errors.join("\n"), /exactly one raw positive select result/);
});

test("upstream content that no longer matches the lock is rejected", async () => {
  await assert.rejects(
    verifyPinnedUpstream({
      fetchImpl: async () => new Response("changed upstream content"),
    }),
    /pinned upstream source hash mismatch/,
  );
});

test("upstream verification bounds hostile transports and response bodies", async () => {
  await assert.rejects(
    verifyPinnedUpstream({
      deadlineMs: 10,
      fetchImpl: () => new Promise(() => undefined),
    }),
    /timed out/,
  );
  await assert.rejects(
    verifyPinnedUpstream({
      fetchImpl: async () => new Response("x", { headers: { "content-length": "1048577" } }),
    }),
    /oversized/,
  );
});
