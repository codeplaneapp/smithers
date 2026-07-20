import fs from 'node:fs'

const TASKS = [
  '/private/tmp/claude-501/-Users-williamcory-smithers2/98126c41-641e-440d-87e6-301ed2061af1/tasks/wb3mo1h88.output', // round 1 (36)
  '/private/tmp/claude-501/-Users-williamcory-smithers2/98126c41-641e-440d-87e6-301ed2061af1/tasks/w3ofrtonu.output', // gap-fill (6)
]

const results = []
let critic = null
for (const t of TASKS) {
  const wrap = JSON.parse(fs.readFileSync(t, 'utf8'))
  const r = wrap.result
  results.push(...r.results)
  if (r.critic) critic = r.critic
}
fs.writeFileSync('audit/raw-findings-full.json', JSON.stringify({ areaCount: results.length, results, critic }, null, 2))

const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 60)
const reconciled = []
for (const a of results) {
  const vmap = new Map()
  const v = a.verification
  if (v && Array.isArray(v.verifiedFindings)) for (const vf of v.verifiedFindings) vmap.set(norm(vf.title), vf)
  for (const f of a.findings || []) {
    const vf = vmap.get(norm(f.title))
    let status = 'unverified', sev = f.severity, note = ''
    if (vf) {
      status = vf.status; note = vf.note || ''
      if (vf.status === 'adjusted' && vf.adjustedSeverity && vf.adjustedSeverity !== 'none') sev = vf.adjustedSeverity
      if (vf.status === 'adjusted' && vf.adjustedSeverity === 'none') status = 'refuted'
    }
    reconciled.push({ area: a.area, verdict: a.verdict, ...f, finalSeverity: sev, vstatus: status, vnote: note })
  }
  if (v && Array.isArray(v.newFindings)) for (const nf of v.newFindings) reconciled.push({ area: a.area, verdict: a.verdict, title: nf.title, severity: nf.severity, finalSeverity: nf.severity, category: nf.category, file: nf.file, evidence: nf.evidence, recommendation: '(verifier-discovered)', confidence: 'high', vstatus: 'confirmed-new', vnote: '' })
}
fs.writeFileSync('audit/reconciled-findings.json', JSON.stringify(reconciled, null, 2))

const kept = reconciled.filter((f) => f.vstatus !== 'refuted')

console.log('===== AREA VERDICTS (', results.length, 'areas ) =====')
const tally = {}
for (const a of results) { tally[a.verdict] = (tally[a.verdict] || 0) + 1 }
console.log('verdict tally:', JSON.stringify(tally))
console.log('\n===== SEVERITY (kept) =====')
for (const s of ['P0', 'P1', 'P2']) console.log(`${s}: ${kept.filter((f) => f.finalSeverity === s).length}`)
console.log('total kept:', kept.length, '| refuted dropped:', reconciled.length - kept.length)
console.log('\n===== CATEGORY (kept) =====')
const byCat = {}; for (const f of kept) byCat[f.category] = (byCat[f.category] || 0) + 1
for (const [c, n] of Object.entries(byCat).sort((a, b) => b[1] - a[1])) console.log(`${c.padEnd(16)} ${n}`)

console.log('\n===== P0 =====')
for (const f of kept.filter((f) => f.finalSeverity === 'P0')) console.log(`[${f.area}] (${f.category}) ${f.title} <${f.vstatus}>`)
console.log('\n===== P1 BUGS + MISSING-FEATURE + ARCHITECTURE (highest-value, kept) =====')
for (const f of kept.filter((f) => f.finalSeverity === 'P1' && ['bug', 'missing-feature', 'architecture', 'adapter'].includes(f.category))) console.log(`[${f.area}] (${f.category}) ${f.title}`)
console.log('\n===== P1 GAP-FILL AREAS ONLY =====')
const gfAreas = new Set(['packages/control-plane', 'packages/gateway', 'packages/tool-context', 'examples', 'ci-gating', 'systemic-synthesis'])
for (const f of kept.filter((f) => f.finalSeverity === 'P1' && gfAreas.has(f.area))) console.log(`[${f.area}] (${f.category}) ${f.title}`)
