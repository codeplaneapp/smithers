/** Logs. Milestone 1 routes the page; the data source lands later. */
import { EmptyState, SectionHeader } from "@smthrs/ui"

export default function OperateLogsPage() {
  return (
    <main className="aomi-page">
      <SectionHeader eyebrow="Operate" title="Logs" />
      <EmptyState title="Nothing here yet" description="Worker logs will be streamed here once the log route exists." />
    </main>
  )
}
