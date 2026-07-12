#!/usr/bin/env node

import { spawnSync as defaultSpawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const root = resolve(dirname(scriptPath), "..");
const reviewsPath = resolve(root, ".github", "production-license-reviews.json");

export const DENIED_PRODUCTION_LICENSES = Object.freeze([
  "AGPL-1.0",
  "AGPL-1.0-only",
  "AGPL-1.0-or-later",
  "AGPL-3.0",
  "AGPL-3.0-only",
  "AGPL-3.0-or-later",
  "GPL-1.0",
  "GPL-1.0-only",
  "GPL-1.0-or-later",
  "GPL-2.0",
  "GPL-2.0-only",
  "GPL-2.0-or-later",
  "GPL-3.0",
  "GPL-3.0-only",
  "GPL-3.0-or-later",
  "SSPL-1.0",
]);

const deniedLicenseIds = new Set(DENIED_PRODUCTION_LICENSES.map((license) => license.toUpperCase()));
const ambiguousLicenseLabels = new Set([
  "UNKNOWN",
  "UNLICENSED",
  "CUSTOM",
  "PROPRIETARY",
  "NOASSERTION",
  "NONE",
]);

function fail(message) {
  throw new Error(`production license audit: ${message}`);
}

function sortedUniqueStrings(values, field) {
  if (!Array.isArray(values) || values.length === 0) {
    fail(`${field} must be a non-empty array`);
  }
  if (values.some((value) => typeof value !== "string" || value.trim() === "")) {
    fail(`${field} must contain only non-empty strings`);
  }
  return [...new Set(values.map((value) => value.trim()))].sort();
}

function parseReviews(document) {
  if (document?.schemaVersion !== 1 || !Array.isArray(document.reviews)) {
    fail("review file must have schemaVersion 1 and a reviews array");
  }

  const reviews = new Map();
  for (const review of document.reviews) {
    for (const field of [
      "package",
      "reportedLicense",
      "reviewedLicense",
      "source",
      "rationale",
    ]) {
      if (typeof review?.[field] !== "string" || review[field].trim() === "") {
        fail(`license review needs a non-empty ${field}`);
      }
    }
    const packageName = review.package.trim();
    if (reviews.has(packageName)) {
      fail(`license review for ${packageName} is duplicated`);
    }
    if (!isImmutableReviewSource(review.source.trim())) {
      fail(`license review for ${packageName} must cite an immutable HTTPS commit URL`);
    }
    const reportedLicense = review.reportedLicense.trim();
    const reviewedLicense = review.reviewedLicense.trim();
    if (!isAmbiguousLicense(reportedLicense)) {
      fail(`license review for ${packageName} must target ambiguous reported metadata`);
    }
    if (isAmbiguousLicense(reviewedLicense)) {
      fail(`license review for ${packageName} must resolve to a concrete license`);
    }
    if (hasDeniedLicense(reviewedLicense)) {
      fail(`license review for ${packageName} resolves to denied license ${reviewedLicense}`);
    }
    reviews.set(packageName, {
      versions: sortedUniqueStrings(review.versions, `${packageName} review versions`),
      reportedLicense,
      reviewedLicense,
      source: review.source.trim(),
    });
  }
  return reviews;
}

function licenseTokens(label) {
  return String(label).match(/[A-Za-z0-9][A-Za-z0-9.-]*/g) ?? [];
}

function hasDeniedLicense(label) {
  const normalized = String(label).toUpperCase();
  if (/\bGNU (?:AFFERO )?GENERAL PUBLIC LICENSE\b/.test(normalized)) return true;
  return licenseTokens(normalized).some((token) =>
    deniedLicenseIds.has(token) ||
    token === "GPL" ||
    token === "AGPL" ||
    token === "SSPL" ||
    /^(?:A?GPL)-(?:1\.0|2\.0|3\.0)(?:-|$)/.test(token) ||
    /^(?:A?GPL)(?:-?V?)(?:1|2|3)(?:\.0)?(?:-|$)/.test(token) ||
    /^SSPL(?:-?V?)?1(?:\.0)?(?:-|$)/.test(token)
  );
}

function isAmbiguousLicense(label) {
  const normalized = String(label).trim().toUpperCase();
  if (normalized.includes("SEE LICENSE IN ")) return true;
  return licenseTokens(normalized).some((token) =>
    ambiguousLicenseLabels.has(token) || token.startsWith("LICENSEREF-")
  );
}

function isImmutableReviewSource(value) {
  try {
    const source = new URL(value);
    return source.protocol === "https:" &&
      source.username === "" &&
      source.password === "" &&
      source.pathname.split("/").some((segment) => /^[0-9a-f]{40}$/i.test(segment));
  } catch {
    return false;
  }
}

function packageLabel(entry) {
  const versions = Array.isArray(entry?.versions) ? entry.versions.join(", ") : "unknown version";
  return `${entry?.name ?? "unknown package"}@${versions}`;
}

/**
 * Enforce the production license policy over `pnpm licenses list --prod --json`.
 * Ambiguous package metadata is fail-closed unless an exact package/version
 * review cites an immutable upstream license source.
 */
export function evaluateProductionLicenses(report, reviewsDocument) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    fail("pnpm returned an unsupported license report");
  }
  const reviews = parseReviews(reviewsDocument);
  const seenReviews = new Set();
  const packageVersions = new Set();
  const violations = [];

  for (const [license, entries] of Object.entries(report)) {
    if (!Array.isArray(entries)) {
      fail(`license group ${license} must be an array`);
    }
    const denied = hasDeniedLicense(license);

    for (const entry of entries) {
      if (typeof entry?.name !== "string" || entry.name.trim() === "") {
        fail(`license group ${license} contains a package without a name`);
      }
      const name = entry.name.trim();
      const versions = sortedUniqueStrings(entry.versions, `${name} versions`);
      for (const version of versions) packageVersions.add(`${name}@${version}`);

      if (denied) {
        violations.push(`${packageLabel(entry)} uses denied license ${license}`);
      }
      if (!isAmbiguousLicense(license)) continue;

      const review = reviews.get(name);
      if (!review) {
        violations.push(`${packageLabel(entry)} reports ${license} and has no pinned license review`);
        continue;
      }
      seenReviews.add(name);
      if (review.reportedLicense !== license) {
        violations.push(
          `${packageLabel(entry)} reports ${license}, but its review expects ${review.reportedLicense}`,
        );
      }
      if (JSON.stringify(review.versions) !== JSON.stringify(versions)) {
        violations.push(
          `${packageLabel(entry)} no longer matches reviewed versions ${review.versions.join(", ")}`,
        );
      }
    }
  }

  for (const name of reviews.keys()) {
    if (!seenReviews.has(name)) {
      violations.push(`license review for ${name} is stale; remove or update it`);
    }
  }

  return {
    packageVersionCount: packageVersions.size,
    reviewedAmbiguousCount: seenReviews.size,
    violations,
  };
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`could not read ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function runProductionLicenseAudit({ spawnSync = defaultSpawnSync } = {}) {
  const executable = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const result = spawnSync(executable, ["licenses", "list", "--prod", "--json"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
    maxBuffer: 32 * 1024 * 1024,
    shell: false,
  });
  if (result.error) {
    fail(`could not start pnpm licenses: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "no output").trim().slice(0, 1_000);
    fail(`pnpm licenses failed (exit ${result.status ?? "unknown"}): ${detail}`);
  }

  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    const detail = (result.stderr || result.stdout || "no output").trim().slice(0, 1_000);
    fail(`pnpm licenses did not return JSON: ${detail}`);
  }
  const outcome = evaluateProductionLicenses(
    report,
    readJson(reviewsPath, reviewsPath),
  );
  if (outcome.violations.length > 0) {
    for (const violation of outcome.violations) console.error(`FAIL ${violation}`);
    return 1;
  }
  console.log(
    `Production license audit passed: ${outcome.packageVersionCount} package versions; ` +
      `${outcome.reviewedAmbiguousCount} pinned metadata review(s).`,
  );
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    process.exitCode = runProductionLicenseAudit();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
