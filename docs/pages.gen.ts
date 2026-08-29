// deno-fmt-ignore-file
// biome-ignore format: generated types do not need formatting
// prettier-ignore
import type { PathsForPages } from 'waku/router'

// prettier-ignore
type Page =
  | { path: '/api/artifacts'; render: 'static' }
  | { path: '/api/canonical'; render: 'static' }
  | { path: '/api/capability'; render: 'static' }
  | { path: '/api/crypto'; render: 'static' }
  | { path: '/api/database'; render: 'static' }
  | { path: '/api/engine-store'; render: 'static' }
  | { path: '/api/engine'; render: 'static' }
  | { path: '/api/flow'; render: 'static' }
  | { path: '/api/flows'; render: 'static' }
  | { path: '/api/jj'; render: 'static' }
  | { path: '/api/journal'; render: 'static' }
  | { path: '/api/kernel'; render: 'static' }
  | { path: '/api/keys'; render: 'static' }
  | { path: '/api/observability'; render: 'static' }
  | { path: '/api/plan'; render: 'static' }
  | { path: '/api/platform-browser'; render: 'static' }
  | { path: '/api/platform-bun'; render: 'static' }
  | { path: '/api/platform-node'; render: 'static' }
  | { path: '/api/run-store'; render: 'static' }
  | { path: '/api/sandbox'; render: 'static' }
  | { path: '/api/step-cache'; render: 'static' }
  | { path: '/api/sync'; render: 'static' }
  | { path: '/api/time-travel'; render: 'static' }
  | { path: '/api-tests'; render: 'static' }
  | { path: '/architecture'; render: 'static' }
  | { path: '/artifact-gc'; render: 'static' }
  | { path: '/code-design'; render: 'static' }
  | { path: '/compaction'; render: 'static' }
  | { path: '/comparisons'; render: 'static' }
  | { path: '/contributing'; render: 'static' }
  | { path: '/data-structures'; render: 'static' }
  | { path: '/design-decisions'; render: 'static' }
  | { path: '/disaster-recovery'; render: 'static' }
  | { path: '/examples/real-world'; render: 'static' }
  | { path: '/examples'; render: 'static' }
  | { path: '/external'; render: 'static' }
  | { path: '/'; render: 'static' }
  | { path: '/internals'; render: 'static' }
  | { path: '/observability'; render: 'static' }
  | { path: '/package-structure'; render: 'static' }
  | { path: '/selection'; render: 'static' }
  | { path: '/sqlite-operating-envelope'; render: 'static' }
  | { path: '/telemetry'; render: 'static' }

// prettier-ignore
declare module 'waku/router' {
  interface RouteConfig {
    paths: PathsForPages<Page>
  }
  interface CreatePagesConfig {
    pages: Page
  }
}
