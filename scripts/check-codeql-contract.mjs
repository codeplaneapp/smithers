#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = resolve(HERE, "..");

const ACTION_SHA = "99df26d4f13ea111d4ec1a7dddef6063f76b97e9";
const BUNDLE_VERSION = "2.26.0";
const BUNDLE_URL = `https://github.com/github/codeql-action/releases/download/codeql-bundle-v${BUNDLE_VERSION}/codeql-bundle-linux64.tar.zst`;
const BUNDLE_SHA256 = "eeaaffa28291513a11565654d9828bac39d9234375a6fc0cd698f61c6d007bae";
const UPSTREAM_COMMIT = "e4a7b4ff515d6f23af5a4b8a837652348657e84b";
const MAX_UPSTREAM_SOURCE_BYTES = 1024 * 1024;
const MAX_CHECKSUM_BYTES = 4 * 1024;
const DEFAULT_NETWORK_DEADLINE_MS = 15_000;

const PACKS = {
  "codeql/javascript-all": "2.8.0",
  "codeql/javascript-queries": "2.4.0",
  "codeql/util": "2.0.39",
};

const UPSTREAM_FILES = [
  [
    "javascript/ql/src/Security/CWE-200/FileAccessToHttp.ql",
    "75a09efb96b21afa9b77fdba10322ee632953945",
    "618c0613936aaf8379200422a944b230d9b39d080fbdfc20f3da8d257e9d0644",
  ],
  [
    "javascript/ql/src/Security/CWE-912/HttpToFileAccess.ql",
    "88362ce545d7df6ccc784b1e9c16d26efa1f5414",
    "0c4f0d7c9af9e2ffd336a8b03b6517064908e26c6481ee45c79792785ac4d89b",
  ],
  [
    "javascript/ql/lib/semmle/javascript/security/dataflow/FileAccessToHttpCustomizations.qll",
    "8fac31ddf54defca1f822697e982c2f1155a1580",
    "7b083d38f31060db36f2633075e40cfe0585d7b924b1e93bfa25dce59b53392b",
  ],
  [
    "javascript/ql/lib/semmle/javascript/security/dataflow/FileAccessToHttpQuery.qll",
    "21efb2b77702459ac4430f95b7cf72025722bd0f",
    "4f82a6c727f4cf138ccadea11bd2cde5eb0e541d54c72fef00bbf64171690d0b",
  ],
  [
    "javascript/ql/lib/semmle/javascript/security/dataflow/HttpToFileAccessCustomizations.qll",
    "46823c990ef77322c1b7a1528f55837baa424f0b",
    "c59fc4001d9fae2222bc31713a9f4732d5fafa4ed58506c0024f625183f42b65",
  ],
  [
    "javascript/ql/lib/semmle/javascript/security/dataflow/HttpToFileAccessQuery.qll",
    "0525367d1e22366eb575b3355aa34297f8b0fc49",
    "556fb74362afc78e910e4a052e5e0f9f7099f69f5718cafa92dbc28c129a1d7d",
  ],
];

const QUERY_CONTRACTS = [
  {
    rel: ".github/codeql/queries/src/SmithersFileAccessToHttp.ql",
    id: "smithers/js-file-access-to-http",
    upstreamId: "js/file-access-to-http",
    customizationAlias: "FileAccessToHttpCustomizations",
    queryImport: "semmle.javascript.security.dataflow.FileAccessToHttpQuery",
    customizationImport:
      "semmle.javascript.security.dataflow.FileAccessToHttpCustomizations::FileAccessToHttp as FileAccessToHttpCustomizations",
    flow: "FileAccessToHttpFlow",
    securitySeverity: "6.5",
    selectMessage: "Outbound network request depends on $@.",
    selectLabel: "file data",
    fixture: ".github/codeql/queries/test/file-access-to-http/SmithersFileAccessToHttp.js",
    qlref: ".github/codeql/queries/test/file-access-to-http/SmithersFileAccessToHttp.qlref",
    expected: ".github/codeql/queries/test/file-access-to-http/SmithersFileAccessToHttp.expected",
    testFile: "SmithersFileAccessToHttp.js",
    boundaries: [
      ["parseValidatedReviewArtifact", "apps/review/action/src/publishReview.ts"],
      ["authorizeWalkthroughUpload", "apps/review/src/cli/publishWalkthrough.ts"],
    ],
  },
  {
    rel: ".github/codeql/queries/src/SmithersHttpToFileAccess.ql",
    id: "smithers/js-http-to-file-access",
    upstreamId: "js/http-to-file-access",
    customizationAlias: "HttpToFileAccessCustomizations",
    queryImport: "semmle.javascript.security.dataflow.HttpToFileAccessQuery",
    customizationImport:
      "semmle.javascript.security.dataflow.HttpToFileAccessCustomizations::HttpToFileAccess as HttpToFileAccessCustomizations",
    flow: "HttpToFileAccessFlow",
    securitySeverity: "6.3",
    selectMessage: "Write to file system depends on $@.",
    selectLabel: "Untrusted data",
    fixture: ".github/codeql/queries/test/http-to-file-access/SmithersHttpToFileAccess.js",
    qlref: ".github/codeql/queries/test/http-to-file-access/SmithersHttpToFileAccess.qlref",
    expected: ".github/codeql/queries/test/http-to-file-access/SmithersHttpToFileAccess.expected",
    testFile: "SmithersHttpToFileAccess.js",
    boundaries: [
      ["serializeValidatedReviewArtifact", "apps/review/action/src/runAction.ts"],
      ["buildCanonicalReviewSummary", "apps/review/src/cli/main.ts"],
    ],
  },
];

function count(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

function same(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function normalized(text) {
  return text.replace(/\s+/g, " ").trim();
}

function yamlList(text, key) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === `${key}:`);
  if (start < 0) return [];
  const values = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) break;
    const item = /^\s*-\s+(.+?)\s*$/.exec(line);
    if (item) values.push(item[1]);
  }
  return values;
}

function selectResultCount(expectedOutput) {
  const section = expectedOutput.match(/(?:^|\n)#select\n([\s\S]*?)(?=\nedges(?:\n|$))/)?.[1] ?? "";
  return section.split("\n").filter((line) => line.startsWith("|")).length;
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sourceHasCall(text, name) {
  const withoutComments = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  return new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`).test(withoutComments);
}

export function collectContractErrors({
  root = DEFAULT_ROOT,
  overrides = new Map(),
  requireSourceBoundaries = true,
} = {}) {
  const errors = [];
  const overrideMap = overrides instanceof Map ? overrides : new Map(Object.entries(overrides));
  const read = (rel) => {
    if (overrideMap.has(rel)) return overrideMap.get(rel);
    const path = resolve(root, rel);
    if (!existsSync(path)) {
      errors.push(`${rel}: missing required contract file`);
      return "";
    }
    return readFileSync(path, "utf8");
  };

  const workflowRel = ".github/workflows/codeql.yml";
  const workflow = read(workflowRel);
  const actionRefs = [...workflow.matchAll(/github\/codeql-action\/(init|autobuild|analyze)@([^\s]+)/g)]
    .map((match) => [match[1], match[2]]);
  const expectedActionRefs = ["init", "autobuild", "analyze"].map((name) => [name, ACTION_SHA]);
  if (!same(actionRefs, expectedActionRefs)) {
    errors.push(`${workflowRel}: init, autobuild, and analyze must pin action commit ${ACTION_SHA}`);
  }
  if (!workflow.includes(`tools: ${BUNDLE_URL}`)) {
    errors.push(`${workflowRel}: CodeQL tools must pin bundle ${BUNDLE_VERSION}`);
  }
  for (const required of [
    "config-file: ./.github/codeql/codeql-config.yml",
    "id: codeql-init",
    "node --test scripts/check-codeql-contract.test.mjs",
    "node scripts/check-codeql-contract.mjs",
    "node scripts/check-codeql-contract.mjs --verify-upstream",
    `test \"\${{ steps.codeql-init.outputs.codeql-version }}\" = \"${BUNDLE_VERSION}\"`,
    `\"\${{ steps.codeql-init.outputs.codeql-path }}\" test run .github/codeql/queries/test --threads=0`,
  ]) {
    if (!workflow.includes(required)) errors.push(`${workflowRel}: missing required line: ${required}`);
  }
  if (/^\s+queries:\s*security-extended\s*$/m.test(workflow)) {
    errors.push(`${workflowRel}: legacy init queries input bypasses the replacement config`);
  }

  const configRel = ".github/codeql/codeql-config.yml";
  const config = read(configRel);
  const uses = [...config.matchAll(/^\s*-\s+uses:\s*(\S+)\s*$/gm)].map((match) => match[1]);
  const expectedUses = [
    "security-extended",
    "./.github/codeql/queries/src/SmithersFileAccessToHttp.ql",
    "./.github/codeql/queries/src/SmithersHttpToFileAccess.ql",
  ];
  if (!same(uses, expectedUses)) {
    errors.push(`${configRel}: security-extended plus exactly two local replacement queries are required`);
  }
  const excludedIds = [...config.matchAll(/^\s+id:\s*(\S+)\s*$/gm)].map((match) => match[1]);
  const expectedExcludedIds = QUERY_CONTRACTS.map(({ upstreamId }) => upstreamId);
  if (!same(excludedIds, expectedExcludedIds)) {
    errors.push(`${configRel}: must exclude exactly ${expectedExcludedIds.join(" and ")}`);
  }
  const ignoredPaths = yamlList(config, "paths-ignore");
  if (!same(ignoredPaths, [".github/codeql/queries/test/**"])) {
    errors.push(`${configRel}: only the intentionally vulnerable query-test fixtures may be ignored`);
  }

  const packRel = ".github/codeql/queries/qlpack.yml";
  const pack = read(packRel);
  for (const [name, version] of Object.entries(PACKS)) {
    if (!new RegExp(`^\\s+${escapeRegExp(name)}:\\s+${escapeRegExp(version)}\\s*$`, "m").test(pack)) {
      errors.push(`${packRel}: ${name} must be pinned to ${version}`);
    }
  }
  if (!/^extractor:\s+javascript\s*$/m.test(pack) || !/^tests:\s+test\s*$/m.test(pack)) {
    errors.push(`${packRel}: extractor and test root must remain explicit`);
  }

  const lockRel = ".github/codeql/upstream-lock.json";
  let lock = null;
  try {
    lock = JSON.parse(read(lockRel));
  } catch (error) {
    errors.push(`${lockRel}: invalid JSON: ${error.message}`);
  }
  if (lock) {
    if (
      lock.schemaVersion !== 1
      || lock.codeqlAction?.commit !== ACTION_SHA
      || lock.codeqlAction?.version !== "4.37.0"
      || lock.bundle?.version !== BUNDLE_VERSION
      || lock.bundle?.linuxUrl !== BUNDLE_URL
      || lock.bundle?.sha256 !== BUNDLE_SHA256
      || lock.upstream?.commit !== UPSTREAM_COMMIT
      || !same(lock.upstream?.packs, PACKS)
    ) errors.push(`${lockRel}: action, bundle, upstream commit, or pack lock drifted`);

    const upstreamFiles = lock.upstream?.files?.map(({ path, gitBlob, sha256: digest }) => [
      path,
      gitBlob,
      digest,
    ]);
    if (!same(upstreamFiles, UPSTREAM_FILES)) {
      errors.push(`${lockRel}: pinned upstream source inventory drifted`);
    }
    const replacements = lock.replacements?.map(({ upstreamId, customId, query, boundaries }) => ({
      upstreamId,
      customId,
      query,
      boundaries,
    }));
    const expectedReplacements = QUERY_CONTRACTS.map(({ upstreamId, id, rel, boundaries }) => ({
      upstreamId,
      customId: id,
      query: rel,
      boundaries,
    }));
    if (!same(replacements, expectedReplacements)) {
      errors.push(`${lockRel}: replacement IDs or audited boundaries drifted`);
    }
  }

  for (const contract of QUERY_CONTRACTS) {
    const query = read(contract.rel);
    const compact = normalized(query);
    for (const required of [
      `@security-severity ${contract.securitySeverity}`,
      `@id ${contract.id}`,
      "@kind path-problem",
      "@problem.severity warning",
      "@precision medium",
      "@tags security",
      "import javascript",
      `import ${contract.customizationImport}`,
      `import ${contract.queryImport}`,
      `import ${contract.flow}::PathGraph`,
      `extends ${contract.customizationAlias}::Sanitizer`,
      "call.getCallee() instanceof VarAccess",
      `from ${contract.flow}::PathNode source, ${contract.flow}::PathNode sink`,
      `where ${contract.flow}::flowPath(source, sink)`,
      `select sink.getNode(), source, sink, \"${contract.selectMessage}\", source.getNode(), \"${contract.selectLabel}\"`,
    ]) {
      if (!compact.includes(normalized(required))) {
        errors.push(`${contract.rel}: missing upstream-compatible query contract: ${required}`);
      }
    }
    if (query.includes(`@id ${contract.upstreamId}`)) {
      errors.push(`${contract.rel}: custom query must not reuse the excluded upstream ID`);
    }
    if (/extends\s+\w+::(?:Source|Sink)/.test(query)) {
      errors.push(`${contract.rel}: source and sink modeling must remain upstream-owned`);
    }
    const pairPattern = /call\.getCalleeName\(\)\s*=\s*"([^"]+)"\s+and\s+call\.getFile\(\)\.getRelativePath\(\)\s*=\s*"([^"]+)"/g;
    const actualPairs = [...query.matchAll(pairPattern)].map((match) => [match[1], match[2]]);
    const expectedPairs = [
      ...contract.boundaries,
      ...contract.boundaries.map(([name]) => [name, contract.testFile]),
    ];
    if (!same(actualPairs, expectedPairs)) {
      errors.push(`${contract.rel}: sanitizer must contain only the exact production and fixture call-site pairs`);
    }

    const fixture = read(contract.fixture);
    if (count(fixture, new RegExp(`\\$ Source\\[${escapeRegExp(contract.id)}\\]`, "g")) !== 1) {
      errors.push(`${contract.fixture}: exactly one raw positive source expectation is required`);
    }
    if (count(fixture, new RegExp(`\\$ Alert\\[${escapeRegExp(contract.id)}\\]`, "g")) !== 1) {
      errors.push(`${contract.fixture}: exactly one raw positive alert expectation is required`);
    }
    for (const [name] of contract.boundaries) {
      if (!sourceHasCall(fixture, name)) {
        errors.push(`${contract.fixture}: missing sanitizer regression case for ${name}`);
      }
    }

    const qlref = read(contract.qlref).trim();
    const expectedQlref = [
      `query: src/${contract.rel.split("/").at(-1)}`,
      "postprocess: utils/test/InlineExpectationsTestQuery.ql",
    ].join("\n");
    if (qlref !== expectedQlref) errors.push(`${contract.qlref}: query-test reference drifted`);
    const expectedOutput = read(contract.expected);
    if (!expectedOutput.trim()) errors.push(`${contract.expected}: expected query-test output must not be empty`);
    if (/(?:^|\n)testFailures(?:\n|$)/.test(expectedOutput)) {
      errors.push(`${contract.expected}: inline expectation failures must never be learned as passing output`);
    }
    if (selectResultCount(expectedOutput) !== 1) {
      errors.push(`${contract.expected}: exactly one raw positive select result is required`);
    }

    if (requireSourceBoundaries) {
      for (const [name, sourceRel] of contract.boundaries) {
        if (!sourceHasCall(read(sourceRel), name)) {
          errors.push(`${sourceRel}: approved boundary ${name} is missing from its pinned call site`);
        }
      }
    }
  }

  return errors;
}

export function assertContract(options) {
  const errors = collectContractErrors(options);
  if (errors.length > 0) throw new Error(`CodeQL replacement contract failed:\n- ${errors.join("\n- ")}`);
}

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("pinned upstream request timed out"));
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("pinned upstream request timed out"));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error) => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}

async function fetchPinnedText(url, maxBytes, label, fetchImpl, deadlineMs, allowedHosts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("pinned upstream request timed out")), deadlineMs);
  try {
    let current = new URL(url);
    let response;
    for (let redirects = 0;; redirects += 1) {
      if (current.protocol !== "https:" || current.username || current.password || !allowedHosts.has(current.hostname)) {
        throw new Error(`${label} redirect escaped its pinned HTTPS hosts`);
      }
      try {
        response = await abortable(
          fetchImpl(current, { redirect: "manual", signal: controller.signal }),
          controller.signal,
        );
      } catch (error) {
        if (error instanceof Error && error.message === "pinned upstream request timed out") throw error;
        throw new Error(`could not fetch ${label}`);
      }
      if (![301, 302, 303, 307, 308].includes(response?.status)) break;
      if (redirects >= 2) throw new Error(`${label} exceeded its redirect boundary`);
      const location = response.headers?.get?.("location");
      if (!location) throw new Error(`${label} redirect has no location`);
      void response.body?.cancel().catch(() => undefined);
      current = new URL(location, current);
    }
    if (!response?.ok) {
      void response?.body?.cancel().catch(() => undefined);
      throw new Error(`could not fetch ${label}: HTTP ${response?.status ?? "unknown"}`);
    }
    const declared = response.headers?.get?.("content-length");
    if (declared !== null && declared !== undefined
      && (!/^(?:0|[1-9]\d*)$/.test(declared) || Number(declared) > maxBytes)) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error(`${label} response is oversized`);
    }
    const reader = response.body?.getReader?.();
    if (!reader) throw new Error(`${label} response has no body`);
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const next = await abortable(reader.read(), controller.signal);
        if (next.done) break;
        total += next.value.byteLength;
        if (total > maxBytes) throw new Error(`${label} response is oversized`);
        chunks.push(next.value);
      }
    } catch (error) {
      void reader.cancel(error).catch(() => undefined);
      throw error;
    } finally {
      try { reader.releaseLock(); } catch { /* a hostile adapter may retain a pending read */ }
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new Error(`${label} response is not valid UTF-8`); }
  } finally {
    clearTimeout(timer);
  }
}

export async function verifyPinnedUpstream({
  fetchImpl = globalThis.fetch,
  deadlineMs = DEFAULT_NETWORK_DEADLINE_MS,
} = {}) {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 30_000) {
    throw new Error("pinned upstream deadline is invalid");
  }
  // collectContractErrors has already proven the checked-in lock matches these
  // constants. Keep network destinations code-owned so a modified lock file
  // can never redirect the scheduled verifier before that result is reported.
  const base = `https://raw.githubusercontent.com/github/codeql/${UPSTREAM_COMMIT}`;
  for (const [path, , expectedSha256] of UPSTREAM_FILES) {
    const content = await fetchPinnedText(
      `${base}/${path}`,
      MAX_UPSTREAM_SOURCE_BYTES,
      `pinned upstream source ${path}`,
      fetchImpl,
      deadlineMs,
      new Set(["raw.githubusercontent.com"]),
    );
    const actual = sha256(content);
    if (actual !== expectedSha256) {
      throw new Error(`pinned upstream source hash mismatch for ${path}: expected ${expectedSha256}, got ${actual}`);
    }
  }

  const checksum = (await fetchPinnedText(
    `${BUNDLE_URL}.checksum.txt`,
    MAX_CHECKSUM_BYTES,
    "pinned CodeQL bundle checksum",
    fetchImpl,
    deadlineMs,
    new Set(["github.com", "release-assets.githubusercontent.com"]),
  )).trim().split(/\s+/, 1)[0];
  if (checksum !== BUNDLE_SHA256) {
    throw new Error(`pinned CodeQL bundle checksum mismatch: expected ${BUNDLE_SHA256}, got ${checksum}`);
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    assertContract();
    if (process.argv.includes("--verify-upstream")) await verifyPinnedUpstream();
    console.log(
      process.argv.includes("--verify-upstream")
        ? "CodeQL replacement contract and pinned upstream sources verified."
        : "CodeQL replacement contract verified.",
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
