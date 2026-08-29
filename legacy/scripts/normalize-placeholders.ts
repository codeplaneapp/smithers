#!/usr/bin/env bun
/**
 * Normalize CLI argument placeholders in docs to uppercase shell-style tokens.
 *
 * Angle-bracket placeholders like `<run-id>` wrap badly in the rendered site
 * (the browser breaks at the hyphen, so `<run-id>` reads as `<run-i d>`) and
 * read as invalid command syntax. Uppercase tokens (`RUN_ID`, `NODE_ID`,
 * `WORKFLOW_ID`) carry no hyphen and are the conventional placeholder form.
 *
 * Two replacement scopes:
 *   1. Hyphenated tokens (`<run-id>`, `<node-id>`, `<workflow-id>`) are replaced
 *      everywhere. They only ever appear as command arguments, so this is safe
 *      and it is exactly the set that triggers the wrap bug.
 *   2. camelCase id tokens (`<runId>`, `<nodeId>`) and bare `<id>` / `<node>`
 *      are replaced only inside fenced shell code blocks, and only on lines
 *      that are not path/URL templates (which legitimately use `<runId>`, e.g.
 *      `.smithers/executions/<runId>/logs/...` or `?runId=<id>`). `<name>` is
 *      left to manual review because its meaning varies (approver, agent,
 *      workflow, file path).
 *
 * Modes:
 *   bun scripts/normalize-placeholders.ts          rewrite files in place
 *   bun scripts/normalize-placeholders.ts --check  exit 1 and list offenders
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const DOCS_ROOT = resolve(REPO_ROOT, "docs");
const CHECK = process.argv.includes("--check");

const HYPHENATED: Array<[RegExp, string]> = [
  [/<run-id>/g, "RUN_ID"],
  [/<node-id>/g, "NODE_ID"],
  [/<workflow-id>/g, "WORKFLOW_ID"],
];

// A shell line that is really a path or URL template, where <runId>/<id> is a
// legitimate angle-bracket placeholder we must leave alone.
export function isPathOrUrlContext(line: string): boolean {
  return /executions\/|\/logs\/|hmr\/|skills\/|\.ndjson|\?runId=|\/gw\/|artifactId/.test(line);
}

// Map a bare <id> to the right token based on the surrounding command on the line.
export function mapBareId(line: string): string {
  if (/--template\s+<id>/.test(line)) return "TEMPLATE_ID";
  if (/workflow\s+(run|inspect)\s+<id>|workflow\s+<id>/.test(line)) return "WORKFLOW_ID";
  if (/--node\s+<id>/.test(line)) return "NODE_ID";
  return "RUN_ID";
}

// Map every id placeholder in a command string to its uppercase token. Leaves
// path/URL templates (which legitimately use <runId>/<id>) untouched.
export function normalizeCommand(text: string): string {
  let out = text;
  for (const [re, tok] of HYPHENATED) out = out.replace(re, tok);
  if (isPathOrUrlContext(out)) return out;
  out = out.replace(/<runId>/g, "RUN_ID").replace(/<run_id>/g, "RUN_ID");
  out = out.replace(/<nodeId>/g, "NODE_ID");
  out = out.replace(/<workflowId>/g, "WORKFLOW_ID");
  // <node> only when it is the node-id argument.
  out = out.replace(/(--node-id\s+|--node\s+)<node>/g, (_m, flag) => `${flag}NODE_ID`);
  out = out.replace(/<id>/g, () => mapBareId(out));
  return out;
}

// In prose, fix the hyphenated tokens globally (the wrap bug) and, inside inline
// code spans that are clearly a smithers command, map the camelCase / <id>
// tokens too. Non-command spans (flag tables, other tools, path/URL templates)
// are left alone.
export function normalizeProseLine(line: string): string {
  let out = line;
  for (const [re, tok] of HYPHENATED) out = out.replace(re, tok);
  return out.replace(/`([^`]+)`/g, (whole, inner) => {
    if (!/smthrs\s/.test(inner) || isPathOrUrlContext(inner)) return whole;
    const fixed = normalizeCommand(inner);
    return fixed === inner ? whole : `\`${fixed}\``;
  });
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (name.endsWith(".mdx") || name.endsWith(".md")) out.push(p);
  }
  return out;
}

export function rewrite(original: string): string {
  const lines = original.split("\n");
  const out: string[] = [];
  let inCode = false;
  let lang = "";
  for (const line of lines) {
    const fence = /^(\s*)(```+)\s*([a-zA-Z0-9_+-]*)\s*$/.exec(line);
    if (fence) {
      inCode = !inCode;
      lang = inCode ? (fence[3] ?? "") : "";
      out.push(line);
      continue;
    }
    const isShell = inCode && ["bash", "sh", "shell", "zsh", "console", ""].includes(lang);
    if (isShell) {
      out.push(normalizeCommand(line));
    } else if (inCode) {
      // Non-shell fenced blocks (ts, json, ...): only the hyphenated wrap-bug tokens.
      let fixed = line;
      for (const [re, tok] of HYPHENATED) fixed = fixed.replace(re, tok);
      out.push(fixed);
    } else {
      out.push(normalizeProseLine(line));
    }
  }
  return out.join("\n");
}

if (import.meta.main) {
  // The root README follows the same house style; gate it alongside docs/.
  const files = [...walk(DOCS_ROOT), join(REPO_ROOT, "README.md")];
  const offenders: string[] = [];
  let changed = 0;
  for (const f of files) {
    const original = readFileSync(f, "utf8");
    const next = rewrite(original);
    if (next === original) continue;
    const rel = relative(REPO_ROOT, f);
    if (CHECK) offenders.push(rel);
    else {
      writeFileSync(f, next);
      changed++;
      console.log(`  ✓ ${rel}`);
    }
  }

  if (CHECK) {
    if (offenders.length) {
      console.error(
        `\n✗ ${offenders.length} doc file(s) use hyphenated angle-bracket CLI placeholders.\n` +
          `  Use uppercase tokens (RUN_ID, NODE_ID, WORKFLOW_ID) instead.\n` +
          `  Run \`bun scripts/normalize-placeholders.ts\` to fix:\n` +
          offenders.map((o) => `    ${o}`).join("\n"),
      );
      process.exit(1);
    }
    console.log("✓ no hyphenated angle-bracket CLI placeholders in docs");
  } else {
    console.log(`\nUpdated ${changed} file(s).`);
  }
}
