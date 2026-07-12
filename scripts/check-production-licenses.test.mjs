import assert from "node:assert/strict";
import test from "node:test";

import {
  DENIED_PRODUCTION_LICENSES,
  evaluateProductionLicenses,
} from "./check-production-licenses.mjs";

const pinnedReview = {
  schemaVersion: 1,
  reviews: [
    {
      package: "missing-metadata",
      versions: ["1.2.3"],
      reportedLicense: "Unknown",
      reviewedLicense: "MIT",
      source: "https://example.com/project/blob/0123456789abcdef0123456789abcdef01234567/LICENSE",
      rationale: "The immutable source license was reviewed.",
    },
  ],
};

test("accepts permissive licenses and an exact pinned metadata review", () => {
  const outcome = evaluateProductionLicenses({
    MIT: [{ name: "permissive", versions: ["2.0.0"] }],
    "Apache-2.0 OR MIT": [{ name: "choice", versions: ["1.0.0"] }],
    Unknown: [{ name: "missing-metadata", versions: ["1.2.3"] }],
  }, pinnedReview);

  assert.deepEqual(outcome, {
    packageVersionCount: 3,
    reviewedAmbiguousCount: 1,
    violations: [],
  });
});

test("rejects every denied SPDX id even inside a compound expression", () => {
  for (const license of DENIED_PRODUCTION_LICENSES) {
    const outcome = evaluateProductionLicenses({
      [`MIT OR ${license}`]: [{ name: "copyleft", versions: ["1.0.0"] }],
    }, { schemaVersion: 1, reviews: [] });
    assert.match(outcome.violations[0], /uses denied license/);
  }
});

test("rejects legacy and natural-language copyleft identifiers", () => {
  for (const license of [
    "GPL-2.0-with-classpath-exception",
    "AGPL-3.0-with-custom-exception",
    "SSPL-1.0-only",
    "GPL v3",
    "GPLv3",
    "AGPL-3",
    "SSPLv1",
    "GNU General Public License version 2",
    "GNU Affero General Public License v3",
  ]) {
    const outcome = evaluateProductionLicenses({
      [license]: [{ name: "copyleft", versions: ["1.0.0"] }],
    }, { schemaVersion: 1, reviews: [] });
    assert.match(outcome.violations[0], /uses denied license/);
  }
});

test("fails closed for unknown, changed, and stale metadata reviews", () => {
  const missing = evaluateProductionLicenses({
    Unknown: [{ name: "new-unknown", versions: ["1.0.0"] }],
  }, { schemaVersion: 1, reviews: [] });
  assert.match(missing.violations[0], /no pinned license review/);

  const changed = evaluateProductionLicenses({
    Unknown: [{ name: "missing-metadata", versions: ["1.2.4"] }],
  }, pinnedReview);
  assert.match(changed.violations[0], /no longer matches reviewed versions/);

  const stale = evaluateProductionLicenses({
    MIT: [{ name: "permissive", versions: ["1.0.0"] }],
  }, pinnedReview);
  assert.match(stale.violations[0], /review for missing-metadata is stale/);

  const custom = evaluateProductionLicenses({
    "MIT OR LicenseRef-Custom": [{ name: "custom", versions: ["1.0.0"] }],
  }, { schemaVersion: 1, reviews: [] });
  assert.match(custom.violations[0], /no pinned license review/);
});

test("rejects malformed review documents and mutable source citations", () => {
  assert.throws(
    () => evaluateProductionLicenses({}, { schemaVersion: 2, reviews: [] }),
    /schemaVersion 1/,
  );
  assert.throws(
    () => evaluateProductionLicenses({}, {
      ...pinnedReview,
      reviews: [{ ...pinnedReview.reviews[0], source: "https://example.com/project/main/LICENSE" }],
    }),
    /immutable HTTPS commit URL/,
  );
  assert.throws(
    () => evaluateProductionLicenses({}, {
      ...pinnedReview,
      reviews: [{
        ...pinnedReview.reviews[0],
        source: "https://example.com/project/LICENSE?ref=/0123456789abcdef0123456789abcdef01234567/",
      }],
    }),
    /immutable HTTPS commit URL/,
  );
  assert.throws(
    () => evaluateProductionLicenses({}, {
      ...pinnedReview,
      reviews: [{ ...pinnedReview.reviews[0], reviewedLicense: "Unknown" }],
    }),
    /must resolve to a concrete license/,
  );
  assert.throws(
    () => evaluateProductionLicenses({}, {
      ...pinnedReview,
      reviews: [{ ...pinnedReview.reviews[0], reviewedLicense: "MIT OR GPL-3.0" }],
    }),
    /resolves to denied license/,
  );
  assert.throws(
    () => evaluateProductionLicenses({}, {
      ...pinnedReview,
      reviews: [{ ...pinnedReview.reviews[0], reportedLicense: "MIT" }],
    }),
    /must target ambiguous reported metadata/,
  );
});
