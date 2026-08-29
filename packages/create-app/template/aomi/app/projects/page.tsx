/** Projects. Milestone 1 routes the page; the data source lands later. */
import { EmptyState, SectionHeader } from "@smthrs/ui"

export default function ProjectsPage() {
  return (
    <main className="aomi-page">
      <SectionHeader eyebrow="Overview" title="Projects" />
      <EmptyState title="Nothing here yet" description="Shipped agents will be listed here once Build can ship one." />
    </main>
  )
}
