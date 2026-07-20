import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Copies the canonical Smithers skills into Pi's skills directory.
 *
 * `skills add` always writes the generated skill set to the canonical
 * `.agents/skills` location, but Pi reads from `~/.pi/agent/skills` (global) or
 * `.pi/skills` (project) and is not in the underlying framework's agent registry.
 * This bridges that gap by copying each canonical skill (any directory containing a
 * `SKILL.md`) into Pi's directory.
 *
 * @param {object} opts
 * @param {boolean} [opts.global] Install globally (default `true`).
 * @param {string} [opts.cwd] Working directory for project-scoped installs.
 * @param {string} [opts.homeDir] Home directory override (for tests).
 * @returns {{ agent: "Pi"; linked: string[]; path: string; reason?: string }}
 */
export function linkPiSkills({ global = true, cwd = process.cwd(), homeDir = homedir() }) {
  const piRoot = join(homeDir, ".pi");
  const piMarker = global ? piRoot : join(cwd, ".pi");
  const targetDir = global ? join(piRoot, "agent", "skills") : join(cwd, ".pi", "skills");
  const sourceDir = global ? join(homeDir, ".agents", "skills") : join(cwd, ".agents", "skills");

  // Detect Pi by the presence of its config directory (scope-matched).
  if (!existsSync(piMarker)) {
    return { agent: "Pi", linked: [], path: targetDir, reason: "not-detected" };
  }
  if (!existsSync(sourceDir)) {
    return { agent: "Pi", linked: [], path: targetDir, reason: "no-source-skills" };
  }

  const linked = [];
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const src = join(sourceDir, entry.name);
    if (!existsSync(join(src, "SKILL.md"))) continue;
    const dest = join(targetDir, entry.name);
    mkdirSync(targetDir, { recursive: true });
    rmSync(dest, { recursive: true, force: true });
    cpSync(src, dest, { recursive: true });
    linked.push(entry.name);
  }

  return { agent: "Pi", linked, path: targetDir };
}
