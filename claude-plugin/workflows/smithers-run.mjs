export const meta = {
  name: 'smithers-run',
  description: 'Launch or attach to a durable Smithers run and mirror it live into /workflows',
  whenToUse: 'Whenever a Smithers workflow runs from this session: the run stays durable in the Smithers engine; this script is its live view.',
  phases: [{ title: 'Run' }],
}

// ---------------------------------------------------------------------------
// The smithers Claude Code plugin's generic /workflows mirror. One script for
// every workflow: phases, kinds, labels, and deltas all come from
// `smithers claude tick` at runtime (contract v1), so nothing here is baked
// per workflow. The real work runs in the Smithers engine; every agent below
// is an observer that runs exactly one CLI command (the `RUN-EXACTLY:` line)
// and relays its JSON or text. Stopping this workflow never stops the run.
//
// args (object, or a JSON string of one):
//   { runId }                            attach to an existing run
//   { workflow, input?, cwd? }           launch a detached run, then mirror it
//   { mirrorAllNodes?, maxLiveWatchers?, agentBudget?, collapseAt? }
// ---------------------------------------------------------------------------

const CONTRACT = 1
const MAX_TICKS = 5000
const TICK_TIMEOUT_MS = 420000 // < the 10-minute Bash cap, with margin
const NODE_WAIT_TIMEOUT_MS = 480000

let workflowArgs = args
if (typeof workflowArgs === 'string') {
  try { workflowArgs = JSON.parse(workflowArgs) } catch { workflowArgs = {} }
}
if (!workflowArgs || (!workflowArgs.runId && !workflowArgs.workflow)) {
  throw new Error('args.runId (attach) or args.workflow (launch) is required')
}

const MAX_LIVE = clampInt(workflowArgs.maxLiveWatchers, 1, 12, 6)
const BUDGET = clampInt(workflowArgs.agentBudget, 10, 950, 900)
const COLLAPSE_AT = clampInt(workflowArgs.collapseAt, 10, 4000, 150)
const MIRROR_ALL = workflowArgs.mirrorAllNodes === true

function clampInt(value, min, max, fallback) {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.min(max, Math.max(min, n))
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

const CLI = workflowArgs.cwd
  ? `cd ${shellQuote(workflowArgs.cwd)} && bunx smithers-orchestrator`
  : 'bunx smithers-orchestrator'

const TICK_SCHEMA = {
  type: 'object',
  required: ['contract', 'runId', 'status', 'seq', 'phases', 'nodes'],
  properties: {
    contract: { type: 'number' },
    runId: { type: 'string' },
    status: { type: 'string' },
    seq: { type: 'number' },
    timedOut: { type: 'boolean' },
    phases: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } },
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['nodeId', 'label', 'phase', 'kind', 'state'],
        properties: {
          nodeId: { type: 'string' },
          label: { type: 'string' },
          phase: { type: 'string' },
          kind: { type: 'string' },
          state: { type: 'string' },
        },
      },
    },
    changed: { type: 'array', items: { type: 'string' } },
    outputs: { type: 'object' },
    approvals: { type: 'array', items: { type: 'object' } },
    humanRequests: { type: 'array', items: { type: 'object' } },
    continuedAs: { type: ['string', 'null'] },
  },
}

const LAUNCH_SCHEMA = {
  type: 'object',
  required: ['runId'],
  properties: { runId: { type: 'string' } },
}

// --- launch or attach ------------------------------------------------------

let runId = workflowArgs.runId ? String(workflowArgs.runId) : ''
const attached = runId.length > 0
if (!runId) {
  const inputFlag = workflowArgs.input === undefined
    ? ''
    : ` --input ${shellQuote(JSON.stringify(workflowArgs.input))}`
  const launched = await agent(
    'Launch a detached Smithers run and return only its run id as structured output. Run this command once:\n' +
    `RUN-EXACTLY: ${CLI} workflow run ${shellQuote(String(workflowArgs.workflow))} --detach${inputFlag} --format json\n` +
    'Extract the run id from the JSON output (field runId or id). Do not run anything else.',
    { label: `launch ${String(workflowArgs.workflow)}`, phase: 'Run', schema: LAUNCH_SCHEMA, effort: 'low' },
  )
  if (!launched || !launched.runId) {
    log('Launch failed: no runId came back. Check `smithers workflow list` and the workflow input.')
    return { runId: null, status: 'launch-failed', mirrored: 0 }
  }
  runId = String(launched.runId)
  log(`Detached Smithers run ${runId} started. Open the browser UI anytime: smithers ui ${runId}`)
}

// --- mirror state ----------------------------------------------------------

const knownPhases = new Set(['Run'])
const mirrored = new Set() // `${runId}:${nodeId}` -> already has (or will get) a row
const loggedGates = new Set()
const pendingRows = [] // fired watcher/echo promises, awaited before returning
let live = 0
let spawned = 0
let seq = 0
let ticks = 0
let lastStatus = ''
let collapsed = false
let budgetLogged = false
let finalStatus = 'unknown'
let errorTicks = 0

const ACTIVE_NODE_STATES = new Set(['in-progress', 'waiting-approval', 'waiting-timer', 'waiting-event'])
const TERMINAL_NODE_STATES = new Set(['finished', 'failed', 'skipped', 'cancelled'])
const TERMINAL_RUN_STATUSES = new Set(['finished', 'failed', 'cancelled'])

function rowKey(nodeId) {
  return `${runId}:${nodeId}`
}

function shouldMirror(node) {
  if (MIRROR_ALL) return true
  return node.kind === 'agent' || node.kind === 'human' || node.kind === 'approval' ||
    node.kind === 'subflow' || node.kind === 'unknown'
}

function watcherPrompt(nodeId) {
  return 'Watch exactly one Smithers node until it is terminal. Run this command (re-run it while the JSON says timedOut true, up to 40 times):\n' +
    `RUN-EXACTLY: ${CLI} claude node-wait ${shellQuote(nodeId)} --run-id ${shellQuote(runId)} --timeout-ms ${NODE_WAIT_TIMEOUT_MS} --format json\n` +
    'Then return plain text only, built from the final JSON: if vanished is true return [skipped]; ' +
    'if state is failed return [failed] followed by the output; if state is cancelled return [cancelled]; ' +
    'otherwise return the output text (or [no output] when empty). Do not perform the node\'s work; only observe.'
}

function echoPrompt(text) {
  return 'Return exactly the text between the markers, nothing else. Do not run tools.\n' +
    'RETURN-EXACTLY-BEGIN\n' + text + '\nRETURN-EXACTLY-END'
}

function fireRow(prompt, label, phaseTitle, opts) {
  spawned += 1
  const p = agent(prompt, { label, phase: phaseTitle, effort: 'low', model: 'haiku', ...(opts || {}) })
    .catch(() => null)
  pendingRows.push(p)
  return p
}

function ensurePhase(title) {
  if (!knownPhases.has(title)) {
    knownPhases.add(title)
    phase(title)
  }
}

function underBudget() {
  if (spawned < BUDGET) return true
  if (!budgetLogged) {
    budgetLogged = true
    log(`Agent budget (${BUDGET}) reached; remaining nodes are summarized per phase at the end.`)
  }
  return false
}

// --- the tick loop ---------------------------------------------------------

phase('Run')
while (ticks < MAX_TICKS) {
  ticks += 1
  // Attach mode reads the current state immediately on the first tick; a
  // just-launched run instead WAITS so the tick cannot race the detached
  // engine's first store write (`--wait` also waits for the run to appear).
  const waitFlag = ticks === 1 && attached ? '' : ` --wait --timeout-ms ${TICK_TIMEOUT_MS}`
  const tick = await agent(
    'Run this command once and return its JSON as structured output. It may take several minutes; that is normal (it blocks until the run changes).\n' +
    `RUN-EXACTLY: ${CLI} claude tick ${shellQuote(runId)} --after-seq ${seq}${waitFlag} --format json\n` +
    'Copy the JSON fields verbatim. Do not run anything else. If the command fails or prints an error instead of a tick, ' +
    `return {"contract": -1, "runId": "${runId}", "status": "error", "seq": 0, "phases": [], "nodes": []} and put the error message in a top-level "error" string field. Never invent tick data.`,
    { label: 'sync', phase: 'Run', schema: TICK_SCHEMA, effort: 'low', model: 'haiku' },
  )
  if (!tick) {
    log(`Mirror sync failed for run ${runId}; stopping the mirror (the Smithers run itself is unaffected).`)
    break
  }
  if (tick.contract === -1) {
    errorTicks += 1
    if (errorTicks < 3) {
      continue
    }
    log(`Mirror sync error for run ${runId}: ${typeof tick.error === 'string' ? tick.error : 'smithers claude tick failed'}. Check the run id and that smithers-orchestrator is up to date, then re-attach with args {"runId":"${runId}"}.`)
    break
  }
  errorTicks = 0
  if (tick.contract !== CONTRACT) {
    log(`smithers claude tick speaks contract ${tick.contract}, this mirror speaks ${CONTRACT}. Update the smithers plugin and smithers-orchestrator, then re-attach with args {"runId":"${runId}"}.`)
    break
  }
  seq = typeof tick.seq === 'number' ? tick.seq : seq
  finalStatus = tick.status

  for (const p of tick.phases || []) {
    if (p && typeof p.title === 'string') ensurePhase(p.title)
  }

  if (tick.status !== lastStatus) {
    if (lastStatus) log(`Run ${runId}: ${lastStatus} -> ${tick.status}`)
    lastStatus = tick.status
  }

  const nodes = Array.isArray(tick.nodes) ? tick.nodes : []
  if (!collapsed && nodes.length > COLLAPSE_AT) {
    collapsed = true
    log(`Run has ${nodes.length} nodes (> ${COLLAPSE_AT}); collapsing to per-phase summaries to respect /workflows caps.`)
  }

  if (!collapsed) {
    const outputs = tick.outputs && typeof tick.outputs === 'object' ? tick.outputs : {}
    for (const node of nodes) {
      if (!node || mirrored.has(rowKey(node.nodeId)) || !shouldMirror(node)) continue
      ensurePhase(node.phase)
      if (ACTIVE_NODE_STATES.has(node.state) && live < MAX_LIVE && underBudget()) {
        mirrored.add(rowKey(node.nodeId))
        live += 1
        fireRow(watcherPrompt(node.nodeId), node.label || node.nodeId, node.phase).finally(() => { live -= 1 })
      } else if (TERMINAL_NODE_STATES.has(node.state) && underBudget()) {
        mirrored.add(rowKey(node.nodeId))
        const text = typeof outputs[node.nodeId] === 'string' && outputs[node.nodeId].length > 0
          ? outputs[node.nodeId]
          : `[${node.state}]`
        fireRow(echoPrompt(text), node.label || node.nodeId, node.phase)
      }
    }
  }

  for (const approval of tick.approvals || []) {
    const key = `approval:${runId}:${approval.nodeId}`
    if (!loggedGates.has(key)) {
      loggedGates.add(key)
      log(`⏸ Approval needed on ${approval.nodeId}${approval.title ? `: ${approval.title}` : ''} — resolve with the resolve_approval MCP tool or \`smithers approve ${runId} ${approval.nodeId}\``)
    }
  }
  for (const request of tick.humanRequests || []) {
    const key = `human:${runId}:${request.requestId || request.nodeId}`
    if (!loggedGates.has(key)) {
      loggedGates.add(key)
      log(`⏸ Human input needed on ${request.nodeId} — relay the question to the user, then answer via ask_human / \`smithers inspect ${runId}\``)
    }
  }

  if (tick.status === 'continued' && typeof tick.continuedAs === 'string' && tick.continuedAs.length > 0) {
    log(`Run ${runId} continued as ${tick.continuedAs}; following the new run.`)
    runId = tick.continuedAs
    seq = 0
    lastStatus = ''
    continue
  }

  if (TERMINAL_RUN_STATUSES.has(tick.status) || tick.status === 'continued') {
    if (collapsed || budgetLogged) {
      // Per-phase summary rows composed from the final tick: the script has
      // all the data, so each summary is a single 1-turn echo agent.
      const byPhase = new Map()
      for (const node of nodes) {
        const list = byPhase.get(node.phase) || []
        list.push(`${node.label || node.nodeId}: ${node.state}`)
        byPhase.set(node.phase, list)
      }
      for (const [phaseTitle, lines] of byPhase) {
        ensurePhase(phaseTitle)
        fireRow(echoPrompt(`${lines.length} nodes\n${lines.join('\n')}`), `${phaseTitle} summary`, phaseTitle)
      }
    }
    break
  }
}

if (ticks >= MAX_TICKS) {
  log(`Tick backstop (${MAX_TICKS}) reached; the mirror stopped following run ${runId}. Re-attach with args {"runId":"${runId}"}.`)
}

await Promise.all(pendingRows)

const failed = finalStatus === 'failed'
log(failed
  ? `Run ${runId} failed. Diagnose with \`smithers autopsy ${runId}\`.`
  : `Mirror complete for run ${runId}: status ${finalStatus}, ${mirrored.size} node rows.`)

return { runId, status: finalStatus, mirrored: mirrored.size, ticks }
