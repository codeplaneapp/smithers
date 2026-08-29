/** Settings. Milestone 1 routes the page; the data source lands later. */
import { EmptyState, SectionHeader } from "@smthrs/ui"

export default function SettingsPage() {
  return (
    <main className="aomi-page">
      <SectionHeader eyebrow="Account" title="Settings" />
      <EmptyState title="Nothing here yet" description="Settings will be editable here once the app stores any." />
    </main>
  )
}
