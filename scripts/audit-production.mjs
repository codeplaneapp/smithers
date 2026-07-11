#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exceptionsPath = resolve(root, ".github", "production-advisory-exceptions.json");
const severityOrder = new Map([
  ["critical", 0],
  ["high", 1],
  ["moderate", 2],
  ["low", 3],
  ["info", 4],
]);
const MAX_EXCEPTION_DAYS = 90;

function fail(message) {
  throw new Error(`production dependency audit: ${message}`);
}

function loadExceptions() {
  let document;
  try {
    document = JSON.parse(readFileSync(exceptionsPath, "utf8"));
  } catch (error) {
    fail(`could not read ${exceptionsPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (document?.schemaVersion !== 1 || !Array.isArray(document.exceptions)) {
    fail("exception file must have schemaVersion 1 and an exceptions array");
  }

  const today = new Date().toISOString().slice(0, 10);
  const latestAllowedExpiry = new Date(Date.now() + MAX_EXCEPTION_DAYS * 24 * 60 * 60 * 1_000)
    .toISOString()
    .slice(0, 10);
  const byId = new Map();
  for (const entry of document.exceptions) {
    for (const field of ["id", "package", "severity", "expiresOn", "rationale", "mitigation"]) {
      if (typeof entry?.[field] !== "string" || entry[field].trim() === "") {
        fail(`exception ${entry?.id ?? "(missing id)"} needs a non-empty ${field}`);
      }
    }
    if (
      !Array.isArray(entry.versions) ||
      entry.versions.length === 0 ||
      entry.versions.some((version) => typeof version !== "string" || version.trim() === "")
    ) {
      fail(`exception ${entry.id} needs a non-empty versions array`);
    }
    if (
      !Array.isArray(entry.paths) ||
      entry.paths.length === 0 ||
      entry.paths.some((path) => typeof path !== "string" || path.trim() === "")
    ) {
      fail(`exception ${entry.id} needs a non-empty dependency paths array`);
    }
    if (!/^GHSA-[a-z0-9-]+$/i.test(entry.id)) {
      fail(`exception id ${entry.id} is not a GitHub advisory id`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.expiresOn)) {
      fail(`exception ${entry.id} has invalid expiresOn ${entry.expiresOn}`);
    }
    if (entry.expiresOn <= today) {
      fail(`exception ${entry.id} expired on ${entry.expiresOn}`);
    }
    if (entry.expiresOn > latestAllowedExpiry) {
      fail(`exception ${entry.id} expires more than ${MAX_EXCEPTION_DAYS} days from now`);
    }
    if (!severityOrder.has(entry.severity)) {
      fail(`exception ${entry.id} has unsupported severity ${entry.severity}`);
    }
    if (byId.has(entry.id)) {
      fail(`exception ${entry.id} is duplicated`);
    }
    byId.set(entry.id, entry);
  }
  return byId;
}

function runAudit() {
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const result = spawnSync(command, ["audit", "--prod", "--json"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) {
    fail(`could not start pnpm audit: ${result.error.message}`);
  }

  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    const detail = (result.stderr || result.stdout || "no output").trim().slice(0, 1_000);
    fail(`pnpm audit did not return JSON (exit ${result.status ?? "unknown"}): ${detail}`);
  }
  if (!report || typeof report !== "object" || !report.advisories || typeof report.advisories !== "object") {
    fail(`pnpm audit returned an unsupported report (exit ${result.status ?? "unknown"})`);
  }
  const advisories = Object.values(report.advisories);
  if (report.error || (result.status !== 0 && advisories.length === 0)) {
    const detail = String(report.error?.message ?? report.message ?? result.stderr ?? "audit failed")
      .trim()
      .slice(0, 1_000);
    fail(`pnpm audit could not complete (exit ${result.status ?? "unknown"}): ${detail}`);
  }
  return advisories;
}

function advisoryId(advisory) {
  return advisory.github_advisory_id || (String(advisory.url ?? "").match(/GHSA-[a-z0-9-]+/i)?.[0] ?? "");
}

function main() {
  const exceptions = loadExceptions();
  const advisories = runAudit().sort((left, right) => {
    const severity = (severityOrder.get(left.severity) ?? 99) - (severityOrder.get(right.severity) ?? 99);
    return severity || String(left.module_name).localeCompare(String(right.module_name));
  });
  const seen = new Set();
  const unexpected = [];

  for (const advisory of advisories) {
    const id = advisoryId(advisory);
    if (!id) {
      unexpected.push({ advisory, reason: "missing stable GHSA id" });
      continue;
    }
    const exception = exceptions.get(id);
    if (!exception) {
      unexpected.push({ advisory, reason: "not allowlisted" });
      continue;
    }
    seen.add(id);
    if (exception.package !== advisory.module_name || exception.severity !== advisory.severity) {
      unexpected.push({ advisory, reason: "exception package or severity no longer matches" });
      continue;
    }
    const foundVersions = [
      ...new Set((advisory.findings ?? []).map((finding) => String(finding.version ?? "")).filter(Boolean)),
    ].sort();
    const exceptedVersions = [...new Set(exception.versions)].sort();
    if (JSON.stringify(foundVersions) !== JSON.stringify(exceptedVersions)) {
      unexpected.push({
        advisory,
        reason: `affected versions changed (found ${foundVersions.join(", ") || "none"})`,
      });
      continue;
    }
    const foundPaths = [
      ...new Set(
        (advisory.findings ?? []).flatMap((finding) =>
          (finding.paths ?? []).map((path) => String(path).trim()).filter(Boolean),
        ),
      ),
    ].sort();
    const exceptedPaths = [...new Set(exception.paths.map((path) => path.trim()))].sort();
    if (JSON.stringify(foundPaths) !== JSON.stringify(exceptedPaths)) {
      unexpected.push({
        advisory,
        reason: "dependency paths changed; review whether the documented mitigation still applies",
      });
      continue;
    }
    if (advisory.patched_versions !== "<0.0.0") {
      unexpected.push({ advisory, reason: `a patched release is now available (${advisory.patched_versions})` });
    }
  }

  const stale = [...exceptions.keys()].filter((id) => !seen.has(id));
  if (unexpected.length > 0 || stale.length > 0) {
    for (const { advisory, reason } of unexpected) {
      const id = advisoryId(advisory) || `npm:${advisory.id ?? "unknown"}`;
      console.error(
        `FAIL ${advisory.severity ?? "unknown"} ${advisory.module_name ?? "unknown"} ${id}: ${reason}\n` +
          `     ${advisory.title ?? advisory.url ?? "no advisory title"}`,
      );
    }
    for (const id of stale) {
      console.error(`FAIL stale exception ${id}: advisory is absent; remove the exception`);
    }
    process.exitCode = 1;
    return;
  }

  if (advisories.length === 0) {
    console.log("Production dependency audit passed with no advisories.");
    return;
  }
  console.log(
    `Production dependency audit passed: ${advisories.length} upstream advisory exception(s), ` +
      `all unpatched and time-bounded.`,
  );
  for (const advisory of advisories) {
    const exception = exceptions.get(advisoryId(advisory));
    console.log(
      `ALLOW ${advisory.severity} ${advisory.module_name} ${advisoryId(advisory)} until ${exception.expiresOn}`,
    );
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
