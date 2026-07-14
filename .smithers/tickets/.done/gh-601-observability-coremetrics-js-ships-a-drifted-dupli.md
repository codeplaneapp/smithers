# 🧹 observability: _coreMetrics.js ships a drifted duplicate metric catalog with a same-named, differently-typed smithersMetrics export

GitHub: https://github.com/smithersai/smithers/issues/601

**What happens**
`apps/observability/src/_coreMetrics.js:76-194` exports `smithersMetricCatalog`, `smithersMetricCatalogByKey/ByName/ByPrometheusName`, and `smithersMetrics` that duplicate `src/metrics/smithersMetricCatalog.js` but have drifted:
- Missing ~25 metrics present in the real catalog (memory*, openApi*, scorers*, snapshot*, runForksCreated, replaysStarted, sandbox size/transport variants, ...).
- `toolDuration` declared with `DURATION_BUCKETS` (100..204800ms) vs the real catalog's `toolBucketValues` (`smithersMetricCatalog.js:434`).
- Its `smithersMetrics` maps key -> metric NAME string (`_coreMetrics.js:194`), while the public `smithersMetrics` (`src/smithersMetrics.js`, re-exported by index.js) maps key -> Metric instance. Same export name, incompatible shape, selected purely by import path.

**Why it's wrong**
Internally only `MetricsService` is imported from this module (`src/index.js:14`, `src/MetricsServiceLive.js:1`), but the package's `"./*"` wildcard export (package.json) makes `observability/_coreMetrics` importable by consumers, who then get a stale catalog and a booby-trapped `smithersMetrics`.

**Expected behavior**
One catalog source of truth (`metrics/smithersMetricCatalog.js`); `_coreMetrics.js` reduced to the `MetricsService` tag (or the wildcard subpath export narrowed so private modules aren't part of the public surface).

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).


> Closed by ticket-fleet: landed on main in 991b03c195a159a058bddaf4a768c8d603b3f291.
