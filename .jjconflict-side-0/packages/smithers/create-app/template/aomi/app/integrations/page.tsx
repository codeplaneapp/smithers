/** Integrations. Milestone 1 routes the page; the data source lands later. */
import { EmptyState, SectionHeader } from "@smthrs/ui"

export default function IntegrationsPage() {
  return (
    <main className="aomi-page">
      <SectionHeader eyebrow="Account" title="Integrations" />
      <EmptyState title="Nothing here yet" description="Integrations will be listed here once the first one is wired." />
    </main>
  )
}
