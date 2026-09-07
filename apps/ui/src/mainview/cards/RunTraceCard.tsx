/*
 * The run trace (Factory design session 2026-09-07 §6b, mocks 7 and 8): the
 * run card's trace facet, built the way a debugger and a distributed tracer
 * show a recursive program. A call tree on the left (run → frame → cell →
 * call), a waterfall on top with one bar per span on a shared time axis, and
 * on the right the selected span's details: a cell's source and prints, a
 * call's input and settlement, a model call's tokens, the seat, and every
 * other field the journal bound at that span.
 *
 * The model is RunTrace.ts's fold over the run card's `events` (the
 * `run-events` projection the pump keeps current while the facet is open).
 * A run with no journal yet is the root alone with the run's status. A run of
 * kind prototype wears the never-promoted banner; nothing else differs.
 *
 * Selection and the filter are presentation state under the pointer; every
 * act that touches the run stays on the run card's own buttons.
 */
import { EmptyState, StatusPill } from "@smthrs/ui"
import { useState } from "react"
import { timeLabel } from "../Timestamps"
import type { Card } from "../state/AppState"
import {
  durationWords,
  spanMatches,
  TRACE_FILTERS,
  type TraceFilter,
  traceFromJournal,
  type TraceModel,
  type TraceSpan,
  waterfallGeometry
} from "./RunTrace"

/** The banner every prototype run wears (design session §6b, mock 8). */
export const PROTOTYPE_BANNER = "Prototypes are evidence for /implement, then reaped. No review, no gates, no landing."

const durationOf = (span: TraceSpan, model: TraceModel): string | undefined => {
  const end = span.endedAt ?? (span.status === "running" || span.status === "waiting" ? model.extent.end : undefined)
  if (end === undefined) return undefined
  return durationWords(Math.max(end - span.startedAt, 0))
}

const json = (value: unknown): string => {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

export const RunTraceBody = ({
  card
}: {
  readonly card: Extract<Card, { kind: "flow-run" }>
}) => {
  const { runId, workflow, phase, kind, events } = card.payload
  const model = traceFromJournal({ runId, flowId: workflow, status: phase, ...(kind === undefined ? {} : { kind }) }, events ?? [])
  const [filter, setFilter] = useState<TraceFilter>("all")
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)
  const rows = model.rows.filter((span) => span.kind === "run" || spanMatches(span, filter))
  const selected = model.rows.find((span) => span.id === selectedId) ?? model.root
  const wall = model.extent.end - model.extent.start
  return (
    <div className="run-trace" data-testid={`run-trace-${runId}`} data-kind={kind}>
      {kind === "prototype" ?
        (
          <p className="run-trace-banner" data-testid={`run-trace-banner-${runId}`}>
            <span className="run-trace-kind">kind: prototype · never promoted</span> {PROTOTYPE_BANNER}
          </p>
        ) :
        null}
      <div className="run-trace-bar" role="group" aria-label="Trace filters">
        {TRACE_FILTERS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            className="run-trace-filter"
            data-filter={id}
            data-on={filter === id}
            aria-pressed={filter === id}
            onClick={() => setFilter(id)}
          >
            {label}
          </button>
        ))}
        <span className="run-trace-clock" data-testid={`run-trace-clock-${runId}`}>
          {model.counts.spans === 0
            ? "no journal yet"
            : `${model.counts.spans} ${model.counts.spans === 1 ? "span" : "spans"}${
              model.counts.running > 0 ? ` · ${model.counts.running} running` : ""
            }${model.counts.failed > 0 ? ` · ${model.counts.failed} failed` : ""} · t = ${durationWords(wall)}`}
        </span>
      </div>
      <div className="run-trace-body">
        <ol className="run-trace-tree" aria-label="Call tree">
          {rows.map((span) => (
            <li key={span.id}>
              <button
                type="button"
                className="run-trace-node"
                data-trace-span={span.id}
                data-kind={span.kind}
                data-status={span.status}
                data-depth={span.depth}
                aria-selected={selected.id === span.id}
                style={{ paddingLeft: `${0.25 + span.depth * 0.875}rem` }}
                onClick={() => setSelectedId(span.id)}
              >
                <span className="run-trace-dot" data-status={span.status} aria-hidden />
                <span className="run-trace-label">{span.label}</span>
                <span className="run-trace-duration">{durationOf(span, model) ?? ""}</span>
              </button>
            </li>
          ))}
        </ol>
        <div className="run-trace-detail">
          {model.counts.spans === 0 ?
            (
              <EmptyState
                description={`No journal yet. The run is ${phase}; spans appear as the workspace records them.`}
                data-testid={`run-trace-empty-${runId}`}
              />
            ) :
            (
              <ol className="run-trace-waterfall" aria-label="Waterfall">
                {rows.filter((span) => span.kind !== "run").map((span) => {
                  const bar = waterfallGeometry(span, model.extent)
                  const instant = span.endedAt !== undefined && span.endedAt <= span.startedAt
                  return (
                    <li key={span.id} className="run-trace-water-row" data-trace-bar={span.id} data-status={span.status}>
                      <span className="run-trace-water-label">{span.label}</span>
                      <span className="run-trace-track">
                        <span
                          className="run-trace-water-bar"
                          data-instant={instant}
                          data-open={span.endedAt === undefined}
                          style={{ left: `${bar.left}%`, width: `${bar.width}%` }}
                        />
                      </span>
                    </li>
                  )
                })}
              </ol>
            )}
          <SpanPane span={selected} model={model} runId={runId} />
        </div>
      </div>
    </div>
  )
}

/** The selected span's facts, and nothing the journal did not record. */
const SpanPane = ({ span, model, runId }: { readonly span: TraceSpan; readonly model: TraceModel; readonly runId: string }) => {
  const { detail } = span
  const duration = durationOf(span, model)
  return (
    <div className="run-trace-pane" data-testid={`run-trace-pane-${runId}`} data-span={span.id}>
      <h5 className="run-trace-pane-title">
        {span.kind} · {span.label} <StatusPill status={span.status} />
      </h5>
      <dl className="run-trace-kv">
        {span.startedAt > 0 ?
          (
            <>
              <dt>started</dt>
              <dd>{timeLabel(span.startedAt)}</dd>
            </>
          ) :
          null}
        {duration !== undefined ?
          (
            <>
              <dt>duration</dt>
              <dd>{duration}{span.endedAt === undefined ? " · open" : ""}</dd>
            </>
          ) :
          null}
        {detail.seat !== undefined ?
          (
            <>
              <dt>seat</dt>
              <dd>{detail.seat}</dd>
            </>
          ) :
          null}
        {detail.usage !== undefined && (detail.usage.inputTokens !== undefined || detail.usage.outputTokens !== undefined) ?
          (
            <>
              <dt>tokens</dt>
              <dd>{detail.usage.inputTokens ?? 0} in / {detail.usage.outputTokens ?? 0} out</dd>
            </>
          ) :
          null}
        {detail.event !== undefined ?
          (
            <>
              <dt>journal</dt>
              <dd>{detail.event}{detail.sequence !== undefined ? ` · #${detail.sequence}` : ""}</dd>
            </>
          ) :
          null}
      </dl>
      {detail.source !== undefined ? <Block title="Cell" text={detail.source} /> : null}
      {detail.printed !== undefined ? <Block title="Printed" text={detail.printed} /> : null}
      {detail.input !== undefined ? <Block title="Input" text={json(detail.input)} /> : null}
      {detail.output !== undefined ? <Block title="Output" text={detail.output} /> : null}
      {detail.message !== undefined ? <Block title="Failure" text={detail.message} alert /> : null}
      {detail.fields !== undefined ?
        (
          <Block
            title="Journal fields"
            text={Object.entries(detail.fields).map(([key, value]) => `${key.padEnd(12)}${json(value)}`).join("\n")}
          />
        ) :
        null}
    </div>
  )
}

const Block = ({ title, text, alert = false }: { readonly title: string; readonly text: string; readonly alert?: boolean }) => (
  <div className="run-trace-block">
    <h5>{title}</h5>
    <pre className="run-trace-code" {...(alert ? { role: "alert" } : {})}>{text}</pre>
  </div>
)
