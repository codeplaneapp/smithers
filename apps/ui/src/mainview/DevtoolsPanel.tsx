import { useLiveQuery } from "@tanstack/react-db"
import { Sparkles } from "lucide-react"
import { useState } from "react"
import { foldLineages } from "./chain/DebugFolds"
import { useController } from "./ControllerContext"
import { SurfaceHeader } from "./SurfaceChrome"

/*
 * The admin dev-tools panel (§2b/§2d): the machinery, visible for admin
 * sessions ONLY — for everyone else it is absent (the commands never
 * register, so devtoolsOpen can never turn true). Chrome attached to the
 * chat, composed from store state like everything else.
 */
export function DevtoolsPanel() {
  const controller = useController()
  const { data: toolCallRows } = useLiveQuery(controller.store.collections.toolCalls)
  const { data: chainEventRows } = useLiveQuery(controller.store.collections.chainEvents)
  const { data: transitionRows } = useLiveQuery(controller.store.collections.transitions)
  const toolCalls = [...toolCallRows].sort((left, right) => left.createdAt - right.createdAt).slice(-30)
  const identity = controller.store.collections.identitySessions.get("identity")
  const billing = controller.store.collections.billingAccounts.get("billing")
  const watched = controller.store.collections.watchedRepos.get("watched")
  const registryState = controller.commands.state()
  /*
   * The journal scrubber (§14 debug mode): an empty cap shows the live fold;
   * a number replays the fold to that offset — read-only time travel, honest
   * by construction because the fold is pure over the recorded prefix.
   */
  const [seqCap, setSeqCap] = useState("")
  const cap = seqCap.trim() === "" ? undefined : Number(seqCap)
  const lineages = foldLineages(
    [...chainEventRows],
    cap !== undefined && Number.isFinite(cap) ? cap : undefined
  )
  const transitions = [...transitionRows].sort((left, right) => right.revision - left.revision).slice(0, 100)
  /*
   * The whole store, as SQLite sees it: every collection with its live row
   * count and a bounded dump. Reads are plain .values() snapshots — the
   * transitions live query above re-renders this panel on every dispatch,
   * so the dumps stay current without thirteen more subscriptions.
   */
  const collectionDumps = Object.entries(controller.store.collections).map(([name, collection]) => {
    const rows = [...(collection as { values: () => Iterable<unknown> }).values()]
    return { name, count: rows.length, rows: rows.slice(-50) }
  })
  return (
    <aside className="devtools-panel" aria-label="Dev tools">
      <SurfaceHeader
        icon={<Sparkles size={17} aria-hidden="true" />}
        title="Dev tools"
        subtitle="The machinery, live"
        closeCommand="admin.devtools"
        onClose={() => controller.runCommand("admin.devtools")}
      />
      <div className="devtools-sections">
        <section className="devtools-section" aria-label="Chain x-ray">
          <h3>Chain</h3>
          {
            /* The scrubber stays mounted even when the cap filters every
					    event out; otherwise the only control that can clear the cap
					    disappears behind a false empty state. */
          }
          <label className="devtools-scrubber">
            replay to seq{" "}
            <input
              value={seqCap}
              onChange={(event) => setSeqCap(event.target.value)}
              placeholder="live"
              inputMode="numeric"
            />
          </label>
          {lineages.length === 0 ? <p className="devtools-empty">No chain turns yet.</p> : (
            <>
              <ul className="devtools-chain">
                {lineages.map((lineage) => (
                  <li key={lineage.lineageId}>
                    <code>{lineage.lineageId}</code>
                    {lineage.goal === undefined ? null : <span>— {lineage.goal}</span>}
                    <span>· {lineage.seqCount} events</span>
                    {Object.keys(lineage.children).length === 0 ?
                      null :
                      <span>· children: {Object.keys(lineage.children).join(", ")}</span>}
                    <ul>
                      {lineage.links.map((link) => (
                        <li key={link.link}>
                          <details>
                            <summary>
                              link {link.link} · {link.calls.length} calls
                              {link.rejections.length > 0 ? ` · ${link.rejections.length} rejected` : ""}
                              {link.outcome === undefined ? "" : ` · ${link.outcome}`}
                            </summary>
                            {link.script === undefined ? null : <pre className="devtools-json">{link.script}</pre>}
                            {link.authorContexts.map((context, index) => (
                              <pre key={index} className="devtools-json">
																{`author context:\n${context.join("\n")}`}
                              </pre>
                            ))}
                            {link.calls.map((call) => (
                              <pre key={call.seq} className="devtools-json">
																{`#${call.ordinal} ${call.name}\n→ ${JSON.stringify(call.payload)}\n← ${JSON.stringify(call.result)}`}
                              </pre>
                            ))}
                            {link.rejections.map((rejection) => (
                              <pre key={rejection.seq} className="devtools-json">
																{`[${rejection.kind}] ${rejection.message}`}
                              </pre>
                            ))}
                            {link.steering.length === 0 ?
                              null :
                              <pre className="devtools-json">{`steering:\n${link.steering.join("\n")}`}</pre>}
                          </details>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
        <section className="devtools-section" aria-label="Store collections">
          <h3>Store · {controller.store.persistenceMode}</h3>
          <ul className="devtools-transitions">
            {collectionDumps.map((dump) => (
              <li key={dump.name}>
                <details>
                  <summary>
                    <code>{dump.name}</code> <span>{dump.count} rows</span>
                  </summary>
                  <pre className="devtools-json">{JSON.stringify(dump.rows, null, 2)}</pre>
                </details>
              </li>
            ))}
          </ul>
        </section>
        <section className="devtools-section" aria-label="Transitions">
          <h3>Transitions</h3>
          <ul className="devtools-transitions">
            {transitions.map((record) => (
              <li key={record.id}>
                <details>
                  <summary>
                    <code>
                      #{record.revision} {record.type}
                    </code>{" "}
                    <span>{record.actor}</span>
                  </summary>
                  <pre className="devtools-json">{record.payload}</pre>
                </details>
              </li>
            ))}
          </ul>
        </section>
        <section className="devtools-section" aria-label="Network tap">
          <h3>Network</h3>
          {(() => {
            const entries = JSON.parse(controller.netTap()) as ReadonlyArray<{
              readonly at: number
              readonly method: string
              readonly url: string
              readonly status: number | "error"
              readonly ms: number
            }>
            return entries.length === 0 ?
              <p className="devtools-empty">No requests yet.</p> :
              (
                <ul className="devtools-net">
                  {entries.slice(0, 30).map((entry) => (
                    <li key={`${entry.at}-${entry.url}`}>
                      <code>
                        {entry.method} {entry.url.replace(/^https?:\/\/[^/]+/, "")} {entry.status} {entry.ms}ms
                      </code>
                    </li>
                  ))}
                </ul>
              )
          })()}
        </section>
        <section className="devtools-section" aria-label="Tool calls">
          <h3>Tool calls</h3>
          {toolCalls.length === 0 ?
            <p className="devtools-empty">No tool calls yet.</p> :
            (
              <ul className="devtools-toolcalls">
                {toolCalls.map((record) => (
                  <li key={record.id}>
                    <code>{record.name}</code>
                    <pre>{record.arguments}</pre>
                    <pre>{record.result}</pre>
                  </li>
                ))}
              </ul>
            )}
        </section>
        <section className="devtools-section" aria-label="Flow registry">
          <h3>Registry</h3>
          <ul className="devtools-registry">
            {controller.commands.entries().map((entry) => (
              <li key={entry.binding.descriptor.name}>
                <code>{entry.binding.descriptor.name}</code>{" "}
                <span>{entry.binding.descriptor.modelInvocable ? "both" : "user"}</span>
              </li>
            ))}
          </ul>
        </section>
        <section className="devtools-section" aria-label="State snapshot">
          <h3>State</h3>
          <pre className="devtools-json">{JSON.stringify(registryState, null, 2)}</pre>
        </section>
        <section className="devtools-section" aria-label="Session facts">
          <h3>Session</h3>
          <pre className="devtools-json">
						{JSON.stringify(
							{
								identity:
									identity === undefined
										? null
										: {
												state: identity.state,
												login: identity.login,
												allowlisted: identity.allowlisted,
												admin: identity.admin,
											},
								billing: billing === undefined ? null : { state: billing.state, totalUsd: billing.totalUsd },
								watchedRepos: watched?.selected ?? null,
							},
							null,
							2,
						)}
          </pre>
        </section>
      </div>
    </aside>
  )
}
