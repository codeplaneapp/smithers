/** Pane `build-plan`: the ordered steps the build pipeline intends to run. */
import { definePane } from "@smthrs/create-app/ui"
import { KpiStat, StatusPill } from "@smthrs/ui"
import * as Schema from "effect/Schema"

const Step = Schema.Struct({
  name: Schema.String,
  status: Schema.Literals(["pending", "running", "done", "failed", "skipped"]),
  detail: Schema.optionalKey(Schema.String)
})

export const Pane = definePane({
  title: "Plan",
  fullscreen: true,
  props: Schema.Struct({
    goal: Schema.String,
    steps: Schema.Array(Step)
  }),
  render: (props, context) => {
    const done = props.steps.filter((step) => step.status === "done").length
    return (
      <div className="aomi-pane-grid" data-fullscreen={context.fullscreen ? "true" : undefined}>
        <div className="aomi-pane-row">
          <KpiStat label="Goal" value={props.goal} />
          <KpiStat label="Steps" value={`${done} / ${props.steps.length}`} hint="done" />
        </div>
        <ol className="aomi-step-list">
          {props.steps.map((step, index) => (
            <li key={`${index}:${step.name}`}>
              <span className="aomi-step-index">{index + 1}</span>
              <span className="aomi-step-name">
                {step.name}
                {step.detail === undefined ? null : <span className="aomi-note">{step.detail}</span>}
              </span>
              <StatusPill status={step.status} />
            </li>
          ))}
        </ol>
      </div>
    )
  }
})
