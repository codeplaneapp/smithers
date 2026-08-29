/** Usage. Milestone 1 routes the page; the data source lands later. */
import { EmptyState, SectionHeader } from "@smthrs/ui"

export default function OperateUsagePage() {
  return (
    <main className="aomi-page">
      <SectionHeader eyebrow="Operate" title="Usage" />
      <EmptyState title="Nothing here yet" description="Model and seat usage will be reported here once turns are metered." />
    </main>
  )
}
