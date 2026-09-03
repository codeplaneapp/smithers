/** Pane `build-files`: the files a build wrote, as a tree. */
import { definePane } from "@smthrs/create-app/ui"
import { Badge, FileTree, KpiStat } from "@smthrs/ui"
import * as Schema from "effect/Schema"

const File = Schema.Struct({
  path: Schema.String,
  status: Schema.optionalKey(Schema.Literals(["added", "modified", "deleted"])),
  bytes: Schema.optionalKey(Schema.Number)
})

const badgeVariant = (status: string | undefined): "success" | "warning" | "destructive" | "muted" => {
  if (status === "added") return "success"
  if (status === "modified") return "warning"
  if (status === "deleted") return "destructive"
  return "muted"
}

export const Pane = definePane({
  title: "Files",
  fullscreen: true,
  props: Schema.Struct({
    root: Schema.optionalKey(Schema.String),
    files: Schema.Array(File),
    selected: Schema.optionalKey(Schema.String)
  }),
  render: (props, context) => {
    const byPath = new Map(props.files.map((file) => [file.path, file]))
    const bytes = props.files.reduce((total, file) => total + (file.bytes ?? 0), 0)
    return (
      <div className="aomi-pane-grid" data-fullscreen={context.fullscreen ? "true" : undefined}>
        <div className="aomi-pane-row">
          <KpiStat label="Root" value={props.root ?? "."} />
          <KpiStat label="Files" value={props.files.length} />
          <KpiStat label="Bytes" value={bytes} />
        </div>
        <FileTree
          nodes={props.files.map((file) => ({ path: file.path }))}
          selected={props.selected ?? null}
          renderAffordance={(node) => {
            const status = byPath.get(node.path)?.status
            return status === undefined ? null : <Badge variant={badgeVariant(status)}>{status}</Badge>
          }}
        />
      </div>
    )
  }
})
