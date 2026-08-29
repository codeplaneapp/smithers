/** Overview. Milestone 1 routes the page; the data source lands later. */
import { EmptyState, SectionHeader } from "@smthrs/ui"

export default function OverviewPage() {
  return (
    <main className="aomi-page">
      <SectionHeader eyebrow="Overview" title="Overview" />
      <EmptyState title="Nothing here yet" description="This shell has no overview data source yet." />
    </main>
  )
}
