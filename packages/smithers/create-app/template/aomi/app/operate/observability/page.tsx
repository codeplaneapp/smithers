/** Observability. Milestone 1 routes the page; the data source lands later. */
import { EmptyState, SectionHeader } from "@smthrs/ui"

export default function OperateObservabilityPage() {
  return (
    <main className="aomi-page">
      <SectionHeader eyebrow="Operate" title="Observability" />
      <EmptyState title="Nothing here yet" description="Traces and metrics will be listed here once the Worker emits them." />
    </main>
  )
}
