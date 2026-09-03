/** Deployments. Milestone 1 routes the page; the data source lands later. */
import { EmptyState, SectionHeader } from "@smthrs/ui"

export default function OperateDeploymentsPage() {
  return (
    <main className="aomi-page">
      <SectionHeader eyebrow="Operate" title="Deployments" />
      <EmptyState title="Nothing here yet" description="Deployments will be listed here once the Worker records them." />
    </main>
  )
}
