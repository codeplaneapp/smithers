#!/usr/bin/env bun
import { readFileSync, renameSync, writeFileSync } from "node:fs";

interface Fixture {
  repository: string;
  prNumber: number;
  prView: Record<string, unknown>;
  filesJsonLines: string;
}

function fail(message: string): never {
  console.error(`offline gh: ${message}`);
  process.exit(64);
}

const fixturePath = process.env.SMITHERS_REVIEW_GH_FIXTURE;
const capturePath = process.env.SMITHERS_REVIEW_CAPTURE_PATH;
if (!fixturePath || !capturePath) fail("fixture/capture path is not configured");

let fixture: Fixture;
try {
  fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture;
} catch (error) {
  fail(`could not read fixture: ${(error as Error).message}`);
}

const args = process.argv.slice(2);
const endpoint = `repos/${fixture.repository}/pulls/${fixture.prNumber}`;

if (args[0] === "pr" && args[1] === "view" && args[2] === String(fixture.prNumber)) {
  process.stdout.write(JSON.stringify(fixture.prView));
  process.exit(0);
}

if (args[0] === "api" && args.includes("user") && args.includes(".login")) {
  process.stdout.write("smithers-review");
  process.exit(0);
}

if (args[0] === "api" && args.includes(`${endpoint}/files`)) {
  process.stdout.write(fixture.filesJsonLines);
  process.exit(0);
}

if (args[0] === "api" && args.includes(`${endpoint}/reviews`) && !args.includes("--method")) {
  // The publisher, not the untrusted analysis phase, owns prior-review updates.
  process.exit(0);
}

if (
  args[0] === "api"
  && args.includes("--method")
  && args[args.indexOf("--method") + 1] === "POST"
  && args.includes(`${endpoint}/reviews`)
) {
  const raw = await Bun.stdin.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("review payload is not valid JSON");
  }
  const temp = `${capturePath}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(parsed), { mode: 0o600 });
  renameSync(temp, capturePath);
  process.stdout.write(JSON.stringify({ html_url: `https://github.com/${fixture.repository}/pull/${fixture.prNumber}` }));
  process.exit(0);
}

fail(`command is outside the read/capture allowlist: ${args.join(" ")}`);
