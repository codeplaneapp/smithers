#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_INIT_FILES = 35;
const MAX_INIT_BYTES = 350 * 1024;
// Headroom above the current ~1.9 MB packed / ~6.7 MB unpacked CLI tarball.
// The packaged docs bundle (apps/cli/docs/llms-full.txt) grows with unrelated
// doc edits, so a threshold within a few percent of the current size would
// false-fail; these limits exist to catch multi-MB regressions like rebundling
// the agent rig, not to ratchet every byte.
const MAX_CLI_PACKED_BYTES = 2_500_000;
const MAX_CLI_UNPACKED_BYTES = 8_000_000;

function readJson(path) {
  return JSON.parse(readFileSync(resolve(root, path), "utf8"));
}

const generated = await import(new URL("../apps/cli/src/seeded-workflow-pack.generated.js", import.meta.url));
const initFiles = generated.GENERATED_SEEDED_FILES;
const initBytes = initFiles.reduce((total, file) => total + Buffer.byteLength(file.contents), 0);

// npm ships as npm.cmd on Windows, which spawnSync cannot resolve from a bare
// "npm" without a shell, so the check failed there with ENOENT.
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const packed = spawnSync(npmCommand, ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  cwd: resolve(root, "apps/cli"),
  encoding: "utf8",
  timeout: 120_000,
});
if (packed.error || packed.status !== 0) {
  throw new Error(`npm pack --dry-run failed: ${packed.error?.message ?? packed.stderr ?? `exit ${packed.status}`}`);
}
const [cliPack] = JSON.parse(packed.stdout);
const cli = readJson("apps/cli/package.json");
const agents = readJson("packages/agents/package.json");

const failures = [];
if (initFiles.length > MAX_INIT_FILES) failures.push(`init file count ${initFiles.length} exceeds ${MAX_INIT_FILES}`);
if (initBytes > MAX_INIT_BYTES) failures.push(`init payload ${initBytes} bytes exceeds ${MAX_INIT_BYTES}`);
if (cliPack.size > MAX_CLI_PACKED_BYTES) {
  failures.push(`@smthrs/cli tarball ${cliPack.size} bytes exceeds ${MAX_CLI_PACKED_BYTES}`);
}
if (cliPack.unpackedSize > MAX_CLI_UNPACKED_BYTES) {
  failures.push(`@smthrs/cli unpacked size ${cliPack.unpackedSize} bytes exceeds ${MAX_CLI_UNPACKED_BYTES}`);
}

for (const name of ["@smthrs/review", "@smthrs/tui"]) {
  if (cli.dependencies?.[name]) failures.push(`${name} must not be a default @smthrs/cli dependency`);
  if (!cli.peerDependenciesMeta?.[name]?.optional) failures.push(`${name} must remain an optional peer`);
}
for (const name of ["@opentui/core", "@opentui/react"]) {
  if (cli.dependencies?.[name]) failures.push(`${name} must stay out of the default @smthrs/cli closure`);
}
if (agents.dependencies?.["@modelcontextprotocol/sdk"]) {
  failures.push("@modelcontextprotocol/sdk must not be a default @smthrs/agents dependency");
}
if (!agents.peerDependenciesMeta?.["@modelcontextprotocol/sdk"]?.optional) {
  failures.push("@modelcontextprotocol/sdk must remain an optional peer of @smthrs/agents");
}

console.log(
  `installed footprint: init ${initFiles.length} files / ${initBytes} bytes; ` +
    `@smthrs/cli ${cliPack.size} packed / ${cliPack.unpackedSize} unpacked bytes`,
);
if (failures.length > 0) {
  console.error(`Installed-footprint check failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  process.exitCode = 1;
}
