/** How Claude Code's /workflows list names and describes this mirror. */
export const meta = {
  name: 'smithers-run',
  description: 'Launch or attach to a durable Smithers run and mirror it live into /workflows',
  whenToUse: 'Whenever a Smithers flow runs from this session: the run stays durable in the Smithers engine; this script is its live view.',
  phases: [{ title: 'Run' }],
}

// ---------------------------------------------------------------------------
// The smithers Claude Code plugin's generic /workflows mirror. One script for
// every flow: phases, kinds, labels, and deltas all come from
// `smithers claude tick` at runtime (claudeMirrorContract 2), so nothing here
// is baked per flow. The real work runs in the Smithers engine; every agent
// below is an observer that runs exactly one CLI command (the `RUN-EXACTLY:`
// line) and relays its JSON or text. Stopping this workflow never stops the
// run.
//
// Contract 2 differs from the 0.x contract 1 in three ways, all of them
// consequences of the 1.0 run model:
//   - run statuses are the seven `ControlSchema.RunStatus` values, so terminal
//     is `completed | failed | cancelled` and the old `finished` is gone;
//   - there is no `continued` status and no `continuedAs` field, because
//     continue-as-new is not an rc.0 feature (the trampoline settles each
//     round `completed` and starts a new run);
//   - there are no human requests, because approvals park the run instead.
//
// args (object, or a JSON string of one):
//   { runId, cwd? }                      attach to an existing run. Pass `cwd`
//                                        whenever the run's workspace is not the
//                                        session's directory (a jj or git
//                                        worktree, a sibling checkout): run
//                                        state lives in that workspace's
//                                        `.flows/`, so without it every tick
//                                        reports an unknown run and the mirror
//                                        ends `mirrored: 0, status: unknown`
//                                        instead of failing loudly.
//   { flow, data?, cwd? }                launch a detached run, then mirror it
//                                        (flow = a discovered flow id).
//   { mirrorAllNodes?, maxLiveWatchers?, agentBudget?, collapseAt? }
//   { cli? }                             command that runs the Smithers CLI
//                                        (default `npx --package @smthrs/cli
//                                        smithers`). Inside a Smithers source
//                                        checkout the SessionStart hook passes
//                                        the working tree's entry so the mirror
//                                        never drives the published build.
// ---------------------------------------------------------------------------

const CONTRACT = 2
// Every tick is one agent turn, so the tick cap is a spend cap. rc.0's
// `smithers claude tick` prints the current frame and exits; there is no
// blocking mode in the shipped verb surface, so a mirror that loops on it as
// fast as the model answers buys one Haiku turn per poll of a run that has not
// moved. The mirror paces itself instead: every tick but the first attach tick
// sleeps in the same shell command, and the pause doubles while the run is
// quiet. At the ceiling that is one turn a minute, and MAX_TICKS is the number
// of turns the mirror is allowed to spend before it tells the operator to
// re-attach.
const TICK_PAUSE_MIN_S = 10
const TICK_PAUSE_MAX_S = 60
const MAX_TICKS = 400
const NODE_WAIT_TIMEOUT_MS = 480000

let workflowArgs = args
if (typeof workflowArgs === 'string') {
  try { workflowArgs = JSON.parse(workflowArgs) } catch { workflowArgs = {} }
}
if (!workflowArgs || (!workflowArgs.runId && !workflowArgs.flow)) {
  throw new Error('args.runId (attach) or args.flow (launch) is required')
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

const CLI_COMMAND = typeof workflowArgs.cli === 'string' && workflowArgs.cli.trim()
  ? workflowArgs.cli.trim()
  : 'npx --package @smthrs/cli smithers'
const CLI = workflowArgs.cwd
  ? `cd ${shellQuote(workflowArgs.cwd)} && ${CLI_COMMAND}`
  : CLI_COMMAND

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
  const dataFlag = workflowArgs.data === undefined
    ? ''
    : ` --data ${shellQuote(JSON.stringify(workflowArgs.data))}`
  const launched = await agent(
    'Launch a detached Smithers run and return only its run id as structured output. Run this command once:\n' +
    `RUN-EXACTLY: ${CLI} up ${shellQuote(String(workflowArgs.flow))} -d${dataFlag} --json\n` +
    'Extract the run id from the JSON output (field runId). Do not run anything else.',
    { label: `launch ${String(workflowArgs.flow)}`, phase: 'Run', schema: LAUNCH_SCHEMA, effort: 'low' },
  )
  if (!launched || !launched.runId) {
    log('Launch failed: no runId came back. Check `smithers ls` and the flow data.')
    return { runId: null, status: 'launch-failed', mirrored: 0 }
  }
  runId = String(launched.runId)
  log(`Detached Smithers run ${runId} started. Follow it anytime: smithers logs ${runId} --follow`)
}

// --- mirror state ----------------------------------------------------------

const knownPhases = new Set(['Run'])
const mirrored = new Set() // `${runId}:${nodeId}` -> already has (or will get) a row
const loggedGates = new Set()
const pendingRows = [] // fired watcher/echo promises, awaited before returning
const stateByNode = new Map() // `${runId}:${nodeId}` -> last seen state, for delta narration
let live = 0
let spawned = 0
let seq = 0
let ticks = 0
let lastStatus = ''
let currentPhase = 'Run' // phase of the furthest active node; groups the tick pollers
let deltasSeeded = !attached // attach mode seeds silently: the first tick is history, not news
let collapsed = false
let budgetLogged = false
let finalStatus = 'unknown'
let errorTicks = 0
let pauseSeconds = TICK_PAUSE_MIN_S

const ACTIVE_NODE_STATES = new Set(['running', 'waiting-approval', 'waiting-timer', 'waiting-event'])
const TERMINAL_NODE_STATES = new Set(['completed', 'failed', 'skipped', 'cancelled'])
const TERMINAL_RUN_STATUSES = new Set(['cancelled', 'completed', 'failed'])

function rowKey(nodeId) {
  return `${runId}:${nodeId}`
}

function shouldMirror(node) {
  if (MIRROR_ALL) return true
  return node.kind === 'agent' || node.kind === 'approval' ||
    node.kind === 'subflow' || node.kind === 'unknown'
}

function watcherPrompt(nodeId) {
  return 'Watch exactly one Smithers node until it is terminal. Run this command (re-run it while the JSON says timedOut true, up to 40 times):\n' +
    `RUN-EXACTLY: ${CLI} claude node-wait ${shellQuote(runId)} ${shellQuote(nodeId)} --timeout-ms ${NODE_WAIT_TIMEOUT_MS} --json\n` +
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

function idList(ids) {
  const MAX_IDS = 6
  return ids.length > MAX_IDS
    ? `${ids.slice(0, MAX_IDS).join(', ')} +${ids.length - MAX_IDS} more`
    : ids.join(', ')
}

// Compact per-tick narration: one line for notable node transitions only
// (started / completed / failed), nothing on heartbeat ticks.
function narrateNodeDeltas(nodes) {
  const started = []
  const completed = []
  const failed = []
  for (const node of nodes) {
    if (!node || typeof node.nodeId !== 'string') continue
    const key = rowKey(node.nodeId)
    const prev = stateByNode.get(key)
    if (prev === node.state) continue
    stateByNode.set(key, node.state)
    if (node.state === 'running') started.push(node.nodeId)
    else if (node.state === 'completed') completed.push(node.nodeId)
    else if (node.state === 'failed') failed.push(node.nodeId)
  }
  if (!deltasSeeded) {
    deltasSeeded = true // first attach tick is pre-existing state, not a delta
    return
  }
  const parts = []
  if (started.length) parts.push(`started ${idList(started)}`)
  if (completed.length) parts.push(`completed ${idList(completed)}`)
  if (failed.length) parts.push(`failed ${idList(failed)}`)
  if (parts.length) log(`Run ${runId} tick #${ticks}: ${parts.join(' · ')}`)
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
  // Attach mode reads the current state immediately on its first tick. Every
  // other tick, including a just-launched run's first, sleeps first: the pause
  // is what keeps the tick from racing the detached engine's first store write,
  // and what keeps a quiet run from costing a turn a second.
  const pause = ticks === 1 && attached ? 0 : pauseSeconds
  const sleepPrefix = pause === 0 ? '' : `sleep ${pause} && `
  const tick = await agent(
    'Run this one shell command and return its JSON as structured output. It begins with a sleep; that is deliberate, so let it finish.\n' +
    `RUN-EXACTLY: ${sleepPrefix}${CLI} claude tick ${shellQuote(runId)} --after-seq ${seq} --json\n` +
    'Copy the JSON fields verbatim. Do not run anything else. If the command fails or prints an error instead of a tick, ' +
    `return {"contract": -1, "runId": "${runId}", "status": "error", "seq": 0, "phases": [], "nodes": []} and put the error message in a top-level "error" string field. Never invent tick data.`,
    {
      label: `tick #${ticks} · ${lastStatus || 'starting'}`,
      phase: currentPhase,
      schema: TICK_SCHEMA,
      effort: 'low',
      model: 'haiku',
    },
  )
  if (!tick) {
    // A null tick means the tick agent died (e.g. a transient network/API
    // failure like ENOTFOUND), not that the run changed state. Treat it like
    // an error tick and retry; only stop after 3 consecutive failures.
    errorTicks += 1
    if (errorTicks < 3) {
      log(`Mirror tick #${ticks} for run ${runId} failed (transient API error); retrying.`)
      continue
    }
    log(`Mirror sync failed ${errorTicks} times in a row for run ${runId}; stopping the mirror (the Smithers run itself is unaffected). Re-attach with args {"runId":"${runId}"}.`)
    break
  }
  if (tick.contract === -1) {
    errorTicks += 1
    if (errorTicks < 3) {
      continue
    }
    log(`Mirror sync error for run ${runId}: ${typeof tick.error === 'string' ? tick.error : 'smithers claude tick failed'}. Check the run id and that @smthrs/cli is up to date, then re-attach with args {"runId":"${runId}"}.`)
    break
  }
  errorTicks = 0
  if (tick.contract !== CONTRACT) {
    log(`smithers claude tick speaks contract ${tick.contract}, this mirror speaks ${CONTRACT}. Update the smithers plugin and @smthrs/cli, then re-attach with args {"runId":"${runId}"}.`)
    break
  }
  // A tick that reports a higher sequence, or a new status, means the run
  // moved: poll again promptly. A tick that reports neither means it did not,
  // so back off before spending the next turn.
  const moved = (typeof tick.seq === 'number' && tick.seq > seq) || tick.status !== lastStatus
  pauseSeconds = moved ? TICK_PAUSE_MIN_S : Math.min(TICK_PAUSE_MAX_S, pauseSeconds * 2)
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

  narrateNodeDeltas(nodes)

  // File the next tick poller under the phase the run is actually in: the
  // furthest node still active this tick (fall back to the last known phase).
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i]
    if (node && ACTIVE_NODE_STATES.has(node.state) && typeof node.phase === 'string' && knownPhases.has(node.phase)) {
      currentPhase = node.phase
      break
    }
  }

  if (!collapsed) {
    const outputs = tick.outputs && typeof tick.outputs === 'object' ? tick.outputs : {}
    for (const node of nodes) {
      if (!node || mirrored.has(rowKey(node.nodeId)) || !shouldMirror(node)) continue
      const nodePhase = typeof node.phase === 'string' && node.phase.length > 0 ? node.phase : 'Run'
      ensurePhase(nodePhase)
      if (ACTIVE_NODE_STATES.has(node.state) && live < MAX_LIVE && underBudget()) {
        mirrored.add(rowKey(node.nodeId))
        live += 1
        fireRow(watcherPrompt(node.nodeId), `watch ${node.nodeId}`, nodePhase).finally(() => { live -= 1 })
      } else if (TERMINAL_NODE_STATES.has(node.state) && underBudget()) {
        mirrored.add(rowKey(node.nodeId))
        const text = typeof outputs[node.nodeId] === 'string' && outputs[node.nodeId].length > 0
          ? outputs[node.nodeId]
          : `[${node.state}]`
        fireRow(echoPrompt(text), node.label || node.nodeId, nodePhase)
      }
    }
  }

  for (const approval of tick.approvals || []) {
    const key = `approval:${runId}:${approval.nodeId}`
    if (!loggedGates.has(key)) {
      loggedGates.add(key)
      log(`⏸ Approval needed on ${approval.nodeId}${approval.title ? `: ${approval.title}` : ''}. Resolve it with the resolve_approval MCP tool, or \`smithers approve <payload>\` using the payload in \`smithers status ${runId}\``)
    }
  }

  if (TERMINAL_RUN_STATUSES.has(tick.status)) {
    if (collapsed || budgetLogged) {
      // Per-phase summary rows composed from the final tick: the script has
      // all the data, so each summary is a single 1-turn echo agent.
      const byPhase = new Map()
      for (const node of nodes) {
        const nodePhase = typeof node.phase === 'string' && node.phase.length > 0 ? node.phase : 'Run'
        const list = byPhase.get(nodePhase) || []
        list.push(`${node.label || node.nodeId}: ${node.state}`)
        byPhase.set(nodePhase, list)
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
  ? `Run ${runId} failed. Diagnose with \`smithers status ${runId}\`.`
  : `Mirror complete for run ${runId}: status ${finalStatus}, ${mirrored.size} node rows.`)

return { runId, status: finalStatus, mirrored: mirrored.size, ticks }
