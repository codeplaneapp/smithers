import fs from 'node:fs'

const full = JSON.parse(fs.readFileSync('audit/raw-findings-full.json', 'utf8'))
const rec = JSON.parse(fs.readFileSync('audit/reconciled-findings.json', 'utf8'))
const kept = rec.filter((f) => f.vstatus !== 'refuted')
const areas = full.results

const cnt = (area, sev) => kept.filter((f) => f.area === area && f.finalSeverity === sev).length
const esc = (s) => (s || '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim()
const sevRank = { P0: 0, P1: 1, P2: 2 }

const P0 = kept.filter((f) => f.finalSeverity === 'P0')
const P1 = kept.filter((f) => f.finalSeverity === 'P1')
const P2 = kept.filter((f) => f.finalSeverity === 'P2')

const order = [
  'packages/engine', 'packages/db', 'packages/agents', 'packages/components', 'packages/time-travel', 'packages/smithers',
  'packages/scheduler', 'packages/driver', 'packages/memory', 'packages/errors', 'packages/server', 'packages/graph',
  'packages/openapi', 'packages/devtools', 'packages/gateway-react', 'packages/gateway-client', 'packages/usage',
  'packages/pi-plugin', 'packages/sandbox', 'packages/scorers', 'packages/protocol', 'packages/accounts',
  'packages/react-reconciler', 'packages/vcs', 'packages/control-plane', 'packages/gateway', 'packages/tool-context',
  'apps/cli', 'apps/observability', 'apps/review', 'examples',
  'docs-human', 'docs-agent-llms', 'workflow-ui-doc-coverage', 'smithers-ui-system', 'adapters-e2e', 'e2e-suite',
  'skills', 'missing-features', 'architecture-deps', 'ci-gating', 'systemic-synthesis',
]
const areaByName = new Map(areas.map((a) => [a.area, a]))
const sortedAreas = [...order.filter((a) => areaByName.has(a)), ...areas.map((a) => a.area).filter((a) => !order.includes(a))]

let md = ''
md += `# Smithers Codebase Audit — "Bulletproof" Review (COMPLETE)\n\n`
md += `**Date:** 2026-06-16  ·  **Reviewer:** multi-agent audit (73 + 12 subagents, two rounds + adversarial verification + completeness critic)\n\n`
md += `**Scope:** *smithers the tool* — \`packages/*\`, \`apps/cli\`, \`apps/observability\`, \`apps/review\`, the \`.smithers\` init pack, \`examples/\`, \`docs/\`, \`skills/\`, \`e2e/\`, and the \`smithers ui\` custom-workflow-UI system.\n`
md += `**Out of scope:** \`apps/smithers\` & \`apps/smithers-studio-2\` (retired POCs; the main product UI lives in a separate repo), \`apps/smithers-demo\`, \`apps/smithers-tui-demo\`, \`~/gui\`, \`../plue\`.\n\n`
md += `**Method:** One deep reviewer per package/app + cross-cutting dimension reviewers (docs, workflow↔UI↔doc coverage, the \`smithers ui\` system, adapters, e2e, skills, missing features, architecture, CI gating, systemic synthesis). Each review was followed by an **adversarial verifier** that tried to refute its findings; a **completeness critic** then found gaps which a second round closed. Findings are graded P0/P1/P2, grounded in \`file:line\` + observed evidence. Full machine-readable data: \`audit/raw-findings-full.json\` (raw) and \`audit/reconciled-findings.json\` (post-verification).\n\n`
md += `---\n\n## Bottom line\n\n`
md += `**${areas.length} areas reviewed → ${areas.filter((a) => a.verdict === 'solid' || a.verdict === 'bulletproof').length} solid, ${areas.filter((a) => a.verdict === 'needs-work').length} needs-work, ${areas.filter((a) => a.verdict === 'shaky' || a.verdict === 'red').length} shaky.** **${kept.length} verified findings: ${P0.length} P0, ${P1.length} P1, ${P2.length} P2** (only ${rec.length - kept.length} findings were refuted by verification — the findings below are high-confidence).\n\n`
md += `The runtime core is genuinely strong: the durable engine, the destructive time-travel/rewind path, the frame codec, migrations, and the \`BaseCliAgent\` subprocess core are well-built and well-tested **against real backends with no mocks**. Smithers is **not** close to "bulletproof" yet, but the gap is bounded and mostly mechanical. The blockers cluster into five themes:\n\n`
md += `1. **The e2e suite largely tests mocks, not the product** (the single biggest threat to the "no-mocks / 100% e2e" bar) — see the P0s.\n`
md += `2. **The high bar is not enforced by CI** — no coverage gate, no lint gate, the flagship package has no test script, and several drift-guards only run at publish.\n`
md += `3. **Type safety is decorative** — \`checkJs\` is off in all 27 packages and 28 packages commit a generated \`.d.ts\` that silently drifts from runtime (this already shipped real bugs).\n`
md += `4. **Several advertised features are no-op stubs** — \`AlertRuntime\`, memory \`TokenLimiter\`/\`Summarizer\`, \`smithers gui\` / \`smithers .\`, and faithfulness scoring on live runs.\n`
md += `5. **Dead code and packaging/type-export defects** — ~66 dead-code findings (whole orphaned subsystems) and broken subpath \`types\` exports across many packages.\n\n`
md += `Every issue found is concrete and fixable. With the P0s + the CI-enforcement + the systemic policy fixes addressed, the rest is a long but mechanical cleanup (tests, dead-code deletion, doc corrections). **If these are fixed, the confidence verdict is: yes, this becomes a bulletproof, well-architected, maintainable codebase.**\n\n`

md += `---\n\n## Scorecard\n\n`
md += `| Area | Verdict | P0 | P1 | P2 |\n|------|---------|----|----|----|\n`
for (const a of sortedAreas) {
  const ar = areaByName.get(a)
  md += `| \`${a}\` | ${ar.verdict} | ${cnt(a, 'P0') || ''} | ${cnt(a, 'P1') || ''} | ${cnt(a, 'P2') || ''} |\n`
}
md += `| **TOTAL** | | **${P0.length}** | **${P1.length}** | **${P2.length}** |\n\n`

md += `---\n\n## P0 — must fix (blocks the bar)\n\n`
for (const f of P0) {
  md += `### [\`${f.area}\`] ${f.title}\n`
  md += `- **Category:** ${f.category}  ·  **File:** \`${esc(f.file)}\`  ·  **Verification:** ${f.vstatus}\n`
  md += `- **Evidence:** ${esc(f.evidence)}\n`
  md += `- **Fix:** ${esc(f.recommendation)}\n\n`
}

md += `---\n\n## P1 — high priority (${P1.length})\n\n`
const catOrder = ['bug', 'missing-feature', 'architecture', 'adapter', 'dead-code', 'test-gap', 'doc', 'clean-code', 'skill', 'ui', 'other']
const catTitle = { bug: 'Bugs', 'missing-feature': 'Missing / stubbed features', architecture: 'Architecture', adapter: 'Adapters', 'dead-code': 'Dead code', 'test-gap': 'Test coverage gaps', doc: 'Documentation', 'clean-code': 'Clean code', skill: 'Skills', ui: 'UI', other: 'Other' }
for (const c of catOrder) {
  const items = P1.filter((f) => f.category === c)
  if (!items.length) continue
  md += `### ${catTitle[c]} (${items.length})\n`
  for (const f of items) {
    md += `- **[\`${f.area}\`]** ${esc(f.title)} — \`${esc(f.file)}\`\n`
    if (f.recommendation && f.recommendation !== '(verifier-discovered)') md += `  - *Fix:* ${esc(f.recommendation)}\n`
  }
  md += `\n`
}

md += `---\n\n## P2 — cleanup backlog (${P2.length})\n\nGrouped by area (one line each; full evidence in \`audit/reconciled-findings.json\`).\n\n`
for (const a of sortedAreas) {
  const items = P2.filter((f) => f.area === a)
  if (!items.length) continue
  md += `**\`${a}\`** (${items.length})\n`
  for (const f of items) md += `- _(${f.category})_ ${esc(f.title)} — \`${esc(f.file)}\`\n`
  md += `\n`
}

md += `---\n\n## Per-area summaries\n\n`
for (const a of sortedAreas) {
  const ar = areaByName.get(a)
  md += `### \`${a}\` — ${ar.verdict}\n`
  md += `${esc(ar.summary)}\n`
  if (ar.coverageEstimate) md += `\n*Coverage:* ${esc(ar.coverageEstimate)}\n`
  md += `\n`
}

md += `---\n\n## Systemic recommendations (policy-level, fix once)\n\n`
md += `These recurred across many areas; fix the policy, not the symptom:\n\n`
md += `1. **Turn on \`checkJs\` repo-wide.** All 27 packages have it off; 831 \`.js\` source files (503 with JSDoc types) ship unverified — this already caused shipped bugs (\`smithers tree --watch\` crash, \`TaskDescriptor\`/error-code type drift).\n`
md += `2. **Stop committing generated \`src/index.d.ts\`** (28 packages) — generate at build + \`.gitignore\`, or add a CI drift-guard. Today the only guard runs at publish, so PRs ship drifted public types.\n`
md += `3. **Enforce the bar in CI:** add a coverage gate, an \`oxlint\` gate, and a \`test\` script to the flagship \`smithers-orchestrator\` package (currently its unit tests never run). Run build-only drift checks (\`gateway check:openapi\`, workflow-pack drift, \`typecheck:examples\`) on PRs, not just at publish.\n`
md += `4. **Make e2e actually e2e.** Replace the 22 fabricated-schema fault cases and the skipped real-path cases with tests that drive the real product (the seeded-fake-agent / browser-skip pattern is fine; fabricating the contract is not).\n`
md += `5. **De-stub or remove advertised features:** \`AlertRuntime\`, memory \`TokenLimiter\`/\`Summarizer\`, \`smithers gui\`/\`smithers .\`, live-run faithfulness scoring, \`AmpAgent\` resume.\n`
md += `6. **Dedupe + delete dead code** (66 findings): orphaned \`ide/\` (~570 LOC), \`db/storage/\` (~763 LOC), engine legacy body (~1759 LOC), \`deferred-bridge.js\`, \`rpc-schema.js\`, time-travel \`types.ts\`, duplicated helper families, etc.\n`
md += `7. **Move \`observability\` to \`packages/\`** — it's published as \`./observability\`, consumed by 14 published packages, but lives under \`apps/\` and forms a publish cycle with \`agents\`.\n`
md += `8. **Refresh \`examples/\`** — 93 of 97 use a deprecated model ID (274 occurrences) and one references a nonexistent \`claude-sonnet-4-7\`; neither "examples smoke test" actually exercises the tree.\n\n`
md += `*This document is generated from \`audit/raw-findings-full.json\` via \`audit/generate-report.mjs\`.*\n`

fs.writeFileSync('audit/REVIEW.md', md)
console.log('Wrote audit/REVIEW.md —', md.split('\n').length, 'lines,', md.length, 'bytes')
console.log('P0:', P0.length, 'P1:', P1.length, 'P2:', P2.length)
