#!/usr/bin/env bun
/**
 * ralph.ts — Review → Plan → Implement loop using Bun shell + Claude Code CLI
 *
 * Usage:
 *   bun ralph.ts <directory> [focus]
 *
 * Runs Claude Code in a loop:
 *   1. Review  — find issues in the codebase
 *   2. Plan    — produce a concrete fix plan
 *   3. Implement — apply the fixes
 *   4. Re-review — check if issues are resolved; loop if not
 */

import { $ } from "bun";
import { readFileSync } from "fs";

let review = "";
while (review.trim() !== "LGTM") {
  await $`
    claude -p ${review || readFileSync("PROMPT.md", "utf-8")}
  `;
  review = (
    await $`
      codex exec
        -c model_reasoning_effort="xhigh"
        --dangerously-bypass-approvals-and-sandbox
        ${readFileSync("REVIEWER.md", "utf-8")}
    `.text()
  ).trim();
}
