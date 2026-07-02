#!/usr/bin/env bun
/**
 * Normalize CLI invocations across docs to use `bunx smithers-orchestrator`.
 *
 * installation.mdx sets the rule: every CLI invocation in the docs is
 * `bunx smithers-orchestrator <command>`. Bare `smithers` is a different npm
 * package and `bunx smithers` runs it, so both bare `smithers <sub>` and
 * `bunx smithers <sub>` (bunx with the wrong package name) are wrong.
 *
 * This rewrites, to `bunx smithers-orchestrator <sub>`:
 *   - bare `smithers <sub>`        (optionally with a `$ ` shell prompt)
 *   - `bunx smithers <sub>`        (bunx + bare package)
 *   - `npx smithers <sub>`         (npx + bare package)
 * where `<sub>` is a known subcommand OR an angle-bracket placeholder such as
 * `<command>` / `<subcommand>` (so docs that write `bunx smithers <command>`
 * generically are caught too, not just concrete subcommands).
 * in two places:
 *   - inside fenced shell code blocks (bash/sh/shell/zsh/console/unlabelled)
 *   - inside inline code spans `like this` in prose and tables
 * It never touches the bare skill/package name `smithers` written without a
 * subcommand (e.g. "the `smithers` skill"), and never touches prose outside
 * code spans (e.g. "the smithers init command").
 *
 * Modes:
 *   bun scripts/normalize-bunx.ts          rewrite files in place
 *   bun scripts/normalize-bunx.ts --check  exit 1 and list offenders, write nothing
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const DOCS_ROOT = resolve(REPO_ROOT, "docs");
const CHECK = process.argv.includes("--check");

// Authoritative top-level subcommands plus nested-command heads, derived from
// apps/cli/src. Matching requires `smithers <sub>` so over-inclusion is safe.
const KNOWN_SUBCOMMANDS = [
  "agents", "alerts", "approve", "ask", "ask-human", "cancel", "capabilities",
  "chat", "chat-create", "create", "cron", "deny", "diff", "docs", "docs-full",
  "doctor", "down", "eval", "events", "fork", "graph", "gui", "hermes", "hijack", "human",
  "init", "inspect", "issue", "list", "logs", "mcp", "memory", "node",
  "observability", "openapi", "optimize", "output", "path", "prompt", "ps",
  "rag", "replay", "reset", "restore", "retry-task", "revert", "revoke",
  "rewind", "run", "scores", "serve", "signal", "skills", "snapshots", "start",
  "starters", "supervise", "test", "ticket", "timeline", "timetravel", "token",
  "travel", "tree", "tui", "ui", "up", "usage", "why", "workflow",
];

const SUB = KNOWN_SUBCOMMANDS.join("|");

// `smithers` (not `smithers-orchestrator`) optionally prefixed by `bunx `/`npx `,
// immediately followed by a known subcommand or an angle-bracket placeholder
// (`<command>`, `<subcommand>`, ...). Capture an optional `$ ` prompt that may
// sit before a bare `smithers` so we can preserve it.
// A leading `/` means this is a slash command (e.g. Hermes's `/smithers run`),
// not a CLI invocation, so never rewrite `/smithers <sub>`.
const CMD_RE = new RegExp(
  String.raw`(bunx\s+|npx\s+)?(?<![/\\\w@.-])smithers(?!-orchestrator)(\s+(?:<[^>]+>|(?:${SUB})\b))`,
  "g",
);

export function normalizeCommands(text: string): string {
  return text.replace(CMD_RE, (_m, _runner, tail) => `bunx smithers-orchestrator${tail}`);
}

// Replace bare/bunx/npx smithers commands inside inline code spans only.
export function normalizeInline(line: string): string {
  return line.replace(/`([^`]+)`/g, (whole, inner) => {
    const fixed = normalizeCommands(inner);
    return fixed === inner ? whole : `\`${fixed}\``;
  });
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (name.endsWith(".mdx") || name.endsWith(".md") || name === "llms-full.txt") {
      out.push(p);
    }
  }
  return out;
}

export function rewrite(original: string): string {
  const lines = original.split("\n");
  const out: string[] = [];
  let inCode = false;
  let fenceLang = "";

  for (const line of lines) {
    const fence = /^(\s*)(```+)\s*([a-zA-Z0-9_+-]*)\s*$/.exec(line);
    if (fence) {
      if (!inCode) {
        inCode = true;
        fenceLang = fence[3] ?? "";
      } else {
        inCode = false;
        fenceLang = "";
      }
      out.push(line);
      continue;
    }
    if (inCode) {
      const isShell = ["bash", "sh", "shell", "zsh", "console", ""].includes(fenceLang);
      out.push(isShell ? normalizeCommands(line) : line);
    } else {
      out.push(normalizeInline(line));
    }
  }

  let result = out.join("\n");
  result = result.replace(
    /the\s+`smithers`\s+command is available via\s+`bunx smithers-orchestrator`\s+or globally if linked\./g,
    "the `smithers` command is invoked via `bunx smithers-orchestrator`. Smithers does not need to be installed globally.",
  );
  return result;
}

// The root README mirrors the docs' house style, but lives outside docs/ so it
// is appended explicitly (CI must enforce the same canonical CLI form there).
if (import.meta.main) {
  const files = [...walk(DOCS_ROOT), join(REPO_ROOT, "README.md")];
  const offenders: string[] = [];
  let changed = 0;

  for (const f of files) {
    const original = readFileSync(f, "utf8");
    const next = rewrite(original);
    if (next === original) continue;
    const rel = relative(REPO_ROOT, f);
    if (CHECK) {
      offenders.push(rel);
    } else {
      writeFileSync(f, next);
      changed++;
      console.log(`  ✓ ${rel}`);
    }
  }

  if (CHECK) {
    if (offenders.length) {
      console.error(
        `\n✗ ${offenders.length} doc file(s) use bare \`smithers\` or \`bunx smithers\` commands.\n` +
          `  Every CLI invocation must be \`bunx smithers-orchestrator <command>\`.\n` +
          `  Run \`bun scripts/normalize-bunx.ts\` to fix:\n` +
          offenders.map((o) => `    ${o}`).join("\n"),
      );
      process.exit(1);
    }
    console.log("✓ all docs use bunx smithers-orchestrator");
  } else {
    console.log(`\nUpdated ${changed} file(s).`);
  }
}
