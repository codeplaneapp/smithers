/** Transactions. Milestone 1 routes the page; the data source lands later. */
import { EmptyState, SectionHeader } from "@smthrs/ui"

export default function OperateTransactionsPage() {
  return (
    <main className="aomi-page">
      <SectionHeader eyebrow="Operate" title="Transactions" />
      <EmptyState title="Nothing here yet" description="Transactions will be listed here once a chain tool writes one." />
    </main>
  )
}
