#!/usr/bin/env bun
import { spawnSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";

const STATE_FILE = ".sandbox-vm";
const ZONE = "us-central1-a";
const MACHINE_TYPE = "e2-small";

// GCE instance names and zones are lowercase letters, digits, and hyphens,
// starting with a letter (RFC 1035, max 63 chars). Anything else in the
// state file is corrupt or tampered with — refuse it before touching gcloud.
const SAFE_RESOURCE = /^[a-z][a-z0-9-]{0,62}$/;

function isSafeResource(value: unknown): value is string {
  return typeof value === "string" && SAFE_RESOURCE.test(value);
}

// Run gcloud with an argument array — never through a shell — so nothing in
// the arguments can be interpolated, split, or executed.
function gcloud(args: string[]): void {
  const result = spawnSync("gcloud", args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const cmd = process.argv[2];

function vmName(): string {
  const ts = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  return `sandbox-${ts}`;
}

if (cmd === "up") {
  const name = vmName();
  console.log(`Creating ${name} (${MACHINE_TYPE}) in ${ZONE}...`);
  gcloud([
    "compute",
    "instances",
    "create",
    name,
    `--machine-type=${MACHINE_TYPE}`,
    "--image-family=debian-12",
    "--image-project=debian-cloud",
    `--zone=${ZONE}`,
  ]);
  writeFileSync(STATE_FILE, JSON.stringify({ name, zone: ZONE }));
  console.log(`\nConnecting to ${name}...`);
  spawnSync("gcloud", ["compute", "ssh", name, `--zone=${ZONE}`, "--ssh-flag=-A"], { stdio: "inherit" });
  console.log(`\nSession ended. Run 'pnpm sandbox:down' to delete the VM.`);
} else if (cmd === "down") {
  if (!existsSync(STATE_FILE)) {
    console.error("No sandbox VM found. Nothing to delete.");
    process.exit(1);
  }
  let state: unknown;
  try {
    state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    console.error(`Corrupt ${STATE_FILE}; delete it and clean up the VM in the GCP console.`);
    process.exit(1);
  }
  const { name, zone } = (state ?? {}) as Record<string, unknown>;
  if (!isSafeResource(name) || !isSafeResource(zone)) {
    console.error(
      `Invalid ${STATE_FILE}: name and zone must be lowercase letters, digits, and hyphens.`,
    );
    process.exit(1);
  }
  console.log(`Deleting ${name}...`);
  gcloud(["compute", "instances", "delete", name, `--zone=${zone}`, "--quiet"]);
  unlinkSync(STATE_FILE);
  console.log("Deleted.");
} else {
  console.error("Usage: pnpm sandbox:[up|down]");
  process.exit(1);
}
