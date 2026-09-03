/** Providers. Milestone 1 routes the page; the data source lands later. */
import { EmptyState, SectionHeader } from "@smthrs/ui"

export default function ProvidersPage() {
  return (
    <main className="aomi-page">
      <SectionHeader eyebrow="Account" title="Providers" />
      <EmptyState title="Nothing here yet" description="Model providers will be listed here once seats are configurable." />
    </main>
  )
}
