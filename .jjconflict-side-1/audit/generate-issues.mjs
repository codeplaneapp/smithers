import fs from 'node:fs'

const rec = JSON.parse(fs.readFileSync('audit/reconciled-findings.json', 'utf8'))
const kept = rec.filter((f) => f.vstatus !== 'refuted')
const BLOB = 'https://github.com/smithersai/smithers/blob/main/audit/REVIEW.md'

const coreSet = new Set([
  'packages/engine', 'packages/db', 'packages/scheduler', 'packages/driver', 'packages/graph', 'packages/time-travel',
  'packages/memory', 'packages/errors', 'packages/protocol', 'packages/accounts', 'packages/usage', 'packages/sandbox',
  'packages/scorers', 'packages/react-reconciler', 'packages/vcs', 'packages/tool-context', 'packages/control-plane',
  'packages/components',
])

const GROUPS = [
  { key: 'p0', title: '🔴 [audit] P0 — critical blockers', labels: ['audit', 'bug'],
    intro: 'The four highest-severity findings from the audit — each blocks the "no-mocks e2e / ~100% coverage / enforced bar" goal.',
    match: (f) => f.finalSeverity === 'P0' },
  { key: 'ci-arch', title: '🏛️ [audit] CI enforcement, architecture & systemic policy', labels: ['audit', 'tech-debt'],
    intro: 'Repo-wide policy/enforcement issues: the high bar is not enforced by CI, plus the systemic root-cause defect classes (checkJs off, committed .d.ts drift, duplicated helpers, the observability publish cycle) and dependency-boundary gaps. Fixing these once removes whole classes of per-package findings.',
    match: (f) => ['ci-gating', 'systemic-synthesis', 'architecture-deps'].includes(f.area) || f.category === 'architecture' },
  { key: 'dead-code', title: '🧹 [audit] Dead code cleanup', labels: ['audit', 'dead-code', 'tech-debt'],
    intro: 'Orphaned subsystems, unused exports, obsolete code, and duplicate parallel implementations. Always re-grep before deleting; some are "wire it in or delete it" decisions.',
    match: (f) => f.category === 'dead-code' },
  { key: 'missing', title: '🧩 [audit] Stubbed & missing features', labels: ['audit', 'enhancement'],
    intro: 'Features advertised in docs/CLI/public API that ship as no-op stubs or are absent — de-stub, implement, or remove the surface.',
    match: (f) => ['missing-feature', 'adapter'].includes(f.category) },
  { key: 'bug', title: '🐛 [audit] Bug fixes', labels: ['audit', 'bug'],
    intro: 'Confirmed correctness defects (P1 first). Each was adversarially verified against the cited code.',
    match: (f) => f.category === 'bug' },
  { key: 'docs', title: '📝 [audit] Documentation & skills accuracy', labels: ['audit', 'documentation'],
    intro: 'Stale/incorrect docs, llms bundles, example model IDs, and skill instructions that diverge from the current tool.',
    match: (f) => ['doc', 'skill'].includes(f.category) },
  { key: 'test-core', title: '✅ [audit] Test coverage gaps — core library packages', labels: ['audit', 'test-coverage'],
    intro: 'Untested functions, branches, error paths, and boundary conditions in the core library packages (toward the ~100% unit-coverage bar incl. error/edge cases).',
    match: (f) => ['test-gap', 'ui'].includes(f.category) && coreSet.has(f.area) },
  { key: 'test-rest', title: '✅ [audit] Test coverage gaps — apps, gateway, UI, e2e, examples', labels: ['audit', 'test-coverage'],
    intro: 'Untested functions, branches, error paths, and boundary conditions across the CLI/apps, gateway/server, gateway-client/react, devtools, pi-plugin, agents, the smithers ui system, the e2e suite, and examples.',
    match: (f) => ['test-gap', 'ui'].includes(f.category) },
  { key: 'cleanup', title: '♻️ [audit] Code cleanup & refactors', labels: ['audit', 'tech-debt'],
    intro: 'Clarity, naming, duplication, error-handling, and other non-bug quality cleanups.',
    match: () => true },
]

// assign each finding to first matching group
const buckets = new Map(GROUPS.map((g) => [g.key, []]))
for (const f of kept) {
  const g = GROUPS.find((g) => g.match(f))
  buckets.get(g.key).push(f)
}

const esc = (s) => (s || '').replace(/\r?\n/g, ' ').trim()
const sevRank = { P0: 0, P1: 1, P2: 2 }
fs.mkdirSync('audit/issues', { recursive: true })
const manifest = []

for (const g of GROUPS) {
  const items = buckets.get(g.key)
  if (!items.length) continue
  const byArea = {}
  for (const f of items) (byArea[f.area] ||= []).push(f)
  const areaKeys = Object.keys(byArea).sort()
  let body = `${g.intro}\n\n`
  body += `Source: [\`audit/REVIEW.md\`](${BLOB}) (2026-06-16 multi-agent audit, adversarially verified). Full per-finding evidence + recommended fix is in \`audit/reconciled-findings.json\`.\n\n`
  body += `**${items.length} findings.**\n\n`
  for (const a of areaKeys) {
    const fs_ = byArea[a].sort((x, y) => sevRank[x.finalSeverity] - sevRank[y.finalSeverity])
    body += `#### \`${a}\` (${fs_.length})\n`
    for (const f of fs_) body += `- [ ] **${f.finalSeverity}** ${esc(f.title)} — \`${esc(f.file)}\`\n`
    body += `\n`
  }
  body += `\n<sub>Filed from the smithers bulletproof audit. Reply on individual lines to split any item into its own issue.</sub>\n`
  const title = `${g.title} (${items.length})`
  const file = `audit/issues/${g.key}.md`
  fs.writeFileSync(file, body)
  manifest.push({ key: g.key, title, labels: g.labels, count: items.length, file, bytes: body.length })
}

fs.writeFileSync('audit/issues/manifest.json', JSON.stringify(manifest, null, 2))
console.log('GROUP'.padEnd(12), 'COUNT'.padStart(6), '  LABELS')
for (const m of manifest) console.log(m.key.padEnd(12), String(m.count).padStart(6), '  ' + m.labels.join(','), '  ', m.title)
console.log('\ntotal findings bucketed:', manifest.reduce((s, m) => s + m.count, 0), 'of', kept.length, 'kept')
