import { readFileSync } from "node:fs";

import { config } from "./config.js";

/**
 * Decode a Python `repr`-style list of strings into a JS string array.
 *
 * Handles single- or double-quoted elements, embedded quotes, and the standard
 * backslash escapes (`\'`, `\"`, `\\`, `\n`, `\t`, `\r`). A blanket
 * single→double quote swap is wrong here: a name containing a literal double
 * quote, or an escaped apostrophe (`\'`), would produce invalid or corrupted
 * JSON. We scan the literal character-by-character instead.
 *
 * @param {string} text   The trimmed list literal, e.g. `"['Test', \"a\\\"b\"]"`.
 * @returns {string[]}
 */
function parsePythonListLiteral(text) {
  if (!text.startsWith("[") || !text.endsWith("]")) {
    throw new SyntaxError("not a list literal");
  }
  const out = [];
  let i = 1;
  const end = text.length - 1;
  while (i < end) {
    const ch = text[i];
    if (ch === " " || ch === "," || ch === "\t" || ch === "\n" || ch === "\r") {
      i += 1;
      continue;
    }
    if (ch !== "'" && ch !== '"') {
      throw new SyntaxError(`unexpected character ${JSON.stringify(ch)} at ${i}`);
    }
    const quote = ch;
    i += 1;
    let value = "";
    while (i < end && text[i] !== quote) {
      if (text[i] === "\\") {
        const next = text[i + 1];
        switch (next) {
          case "n": value += "\n"; break;
          case "t": value += "\t"; break;
          case "r": value += "\r"; break;
          case "\\": value += "\\"; break;
          case "'": value += "'"; break;
          case '"': value += '"'; break;
          default: value += next ?? "\\"; break;
        }
        i += 2;
      } else {
        value += text[i];
        i += 1;
      }
    }
    if (i >= end) throw new SyntaxError("unterminated string in list literal");
    i += 1; // consume closing quote
    out.push(value);
  }
  return out;
}

/**
 * The list-typed columns in SWE-Bench Pro are stored as *strings* containing a
 * Python/JSON list literal (e.g. `"['TestLoad']"`). The canonical evaluator
 * decodes them with `eval()`; we keep the original string verbatim for byte-for
 * byte fidelity in the scoring container and additionally expose a parsed array.
 *
 * @param {string} raw
 * @param {string} [rowId]   Instance id, surfaced in the error if parsing fails.
 * @returns {string[]}
 */
function parseListLiteral(raw, rowId) {
  if (raw == null || raw === "") return [];
  if (Array.isArray(raw)) return raw;
  const text = String(raw).trim();
  try {
    return JSON.parse(text);
  } catch {
    try {
      return parsePythonListLiteral(text);
    } catch (err) {
      const where = rowId ? ` for instance "${rowId}"` : "";
      throw new Error(
        `failed to parse list literal${where}: ${err.message} (value: ${JSON.stringify(text.slice(0, 200))})`,
      );
    }
  }
}

/**
 * @typedef {object} SwebpInstance
 * @property {string} instanceId
 * @property {string} repo
 * @property {string} repoLanguage
 * @property {string} baseCommit
 * @property {string} dockerImage          Fully-qualified image ref to score against.
 * @property {string} problemStatement     Shown to the agent.
 * @property {string} requirements          Shown to the agent (behavioral spec).
 * @property {string} interface             Shown to the agent (signatures/paths).
 * @property {string[]} failToPass          Tests that must flip failing → passing.
 * @property {string[]} passToPass          Regression tests that must stay passing.
 * @property {string[]} selectedTestFiles   Args passed to run_script.sh.
 * @property {string} goldPatch             Reference solution (NEVER shown to the agent).
 * @property {string} testPatch             Hidden test diff (NEVER shown to the agent).
 * @property {object} raw                   Original row, for the canonical evaluator.
 */

/**
 * Build the Docker Hub image reference for an instance. Mirrors
 * `helper_code/image_uri.py::get_dockerhub_image_uri` from the canonical harness,
 * but the dataset already ships the exact `dockerhub_tag`, so we prefer that.
 *
 * @param {Record<string, unknown>} row
 * @returns {string}
 */
function imageRefFor(row) {
  const tag = String(row.dockerhub_tag ?? "").trim();
  return `${config.dockerhubUsername}/sweap-images:${tag}`;
}

/**
 * Load SWE-Bench Pro instances from the normalized JSONL dataset.
 *
 * @param {object} [opts]
 * @param {string} [opts.datasetPath]   Override the dataset path.
 * @param {string[]} [opts.ids]          Keep only these instance ids (in order).
 * @param {string[]} [opts.repos]        Keep only these repos.
 * @param {string[]} [opts.languages]    Keep only these repo languages.
 * @param {number} [opts.limit]          Cap the number returned.
 * @returns {SwebpInstance[]}
 */
export function loadInstances(opts = {}) {
  const datasetPath = opts.datasetPath ?? config.datasetPath;
  const lines = readFileSync(datasetPath, "utf8").split("\n").filter(Boolean);
  /** @type {SwebpInstance[]} */
  let instances = lines.map((line) => {
    const row = JSON.parse(line);
    return {
      instanceId: row.instance_id,
      repo: row.repo,
      repoLanguage: row.repo_language,
      baseCommit: row.base_commit,
      dockerImage: imageRefFor(row),
      problemStatement: row.problem_statement ?? "",
      requirements: row.requirements ?? "",
      interface: row.interface ?? "",
      failToPass: parseListLiteral(row.fail_to_pass, row.instance_id),
      passToPass: parseListLiteral(row.pass_to_pass, row.instance_id),
      selectedTestFiles: parseListLiteral(row.selected_test_files_to_run, row.instance_id),
      goldPatch: row.patch ?? "",
      testPatch: row.test_patch ?? "",
      raw: row,
    };
  });

  if (opts.ids?.length) {
    const order = new Map(opts.ids.map((id, i) => [id, i]));
    instances = instances
      .filter((it) => order.has(it.instanceId))
      .sort((a, b) => order.get(a.instanceId) - order.get(b.instanceId));
  }
  if (opts.repos?.length) {
    const set = new Set(opts.repos);
    instances = instances.filter((it) => set.has(it.repo));
  }
  if (opts.languages?.length) {
    const set = new Set(opts.languages);
    instances = instances.filter((it) => set.has(it.repoLanguage));
  }
  if (opts.limit != null) instances = instances.slice(0, opts.limit);
  return instances;
}
