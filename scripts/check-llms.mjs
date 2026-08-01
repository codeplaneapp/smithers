#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { versionedGeneratorArgs } from "./llms-check-mode.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageVersion = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
const generatedFiles = [
  "docs/llms.txt",
  "docs/llms-core.txt",
  "docs/llms-memory.txt",
  "docs/llms-openapi.txt",
  "docs/llms-observability.txt",
  "docs/llms-effect.txt",
  "docs/llms-integrations.txt",
  "docs/llms-events.txt",
  "docs/llms-full.txt",
  `docs/llms-v${packageVersion}.txt`,
  `docs/llms-full-v${packageVersion}.txt`,
  "skills/smithers/llms-full.txt",
  "apps/cli/docs/llms.txt",
  "apps/cli/docs/llms-full.txt",
  "packages/smithers/docs/llms.txt",
  "packages/smithers/docs/llms-full.txt",
];

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

/**
 * A git release tag freezes the historical bundle even when npm publication
 * is intentionally delayed.
 *
 * @param {string} version
 * @returns {"published" | "unpublished" | "unavailable"}
 */
function checkNpmPublication(version) {
  const tagRef = `refs/tags/v${version}`;
  const localTag = spawnSync("git", ["rev-parse", "--verify", "--quiet", tagRef], {
    cwd: root,
    stdio: "ignore",
  });
  if (localTag.status === 0) return "published";

  // actions/checkout fetches a shallow, tagless clone by default. Check the
  // canonical remote before falling back to npm so tagged snapshots stay
  // immutable in CI too.
  const remoteTag = spawnSync("git", ["ls-remote", "--exit-code", "--tags", "origin", tagRef], {
    cwd: root,
    stdio: "ignore",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (remoteTag.status === 0) return "published";

  // npm is npm.cmd on Windows; .cmd files only spawn through a shell.
  const result = spawnSync("npm", ["view", `smthrs@${version}`, "version"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  if (result.status === 0) return "published";
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (/\bE404\b|404\s+(?:Not Found|No match)|No match found for version/i.test(output)) {
    const ref = `refs/tags/v${version}`;
    const localTag = spawnSync("git", ["show-ref", "--verify", "--quiet", ref], { cwd: root });
    if (localTag.status === 0) return "published";
    const remoteTag = spawnSync("git", ["ls-remote", "--exit-code", "--tags", "origin", ref], {
      cwd: root,
      stdio: "ignore",
    });
    if (remoteTag.status === 0) return "published";
    if (remoteTag.status === 2) return "unpublished";
  }
  return "unavailable";
}

const before = new Map(
  generatedFiles.map((file) => [
    file,
    existsSync(resolve(root, file)) ? readFileSync(resolve(root, file), "utf8") : null,
  ]),
);

let versionedArgs;
try {
  versionedArgs = versionedGeneratorArgs(checkNpmPublication(packageVersion), packageVersion);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

run("bun", ["scripts/generate-llms.ts", ...versionedArgs]);
run("bun", ["scripts/optimize-llms-full.ts", ...versionedArgs]);

const changed = generatedFiles.filter((file) => {
  const path = resolve(root, file);
  const previous = before.get(file) ?? null;
  const current = existsSync(path) ? readFileSync(path, "utf8") : null;
  return previous !== current;
});

if (changed.length) {
  const status = spawnSync("git", ["status", "--porcelain", "--", ...changed], {
    cwd: root,
    encoding: "utf8",
  });
  if (status.status !== 0) {
    process.exit(status.status ?? 1);
  }
  console.error("Generated llms artifacts are out of date:");
  console.error(status.stdout.trimEnd() || changed.map((file) => ` M ${file}`).join("\n"));
  console.error("\nRun `pnpm docs:llms` and commit the resulting files.");
  process.exit(1);
}
