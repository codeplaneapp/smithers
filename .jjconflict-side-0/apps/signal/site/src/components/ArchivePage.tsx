import { Card, CardContent, CardHeader, CardTitle, EmptyState } from "smithers-orchestrator/ui";

export function ArchivePage(props: { dates: string[]; onOpen: (date: string) => void }) {
  if (props.dates.length === 0) {
    return <EmptyState title="No archived issues yet" description="Check back after the first issue publishes." />;
  }
  const sorted = [...props.dates].sort().reverse();
  return (
    <Card className="signal-archive">
      <CardHeader>
        <CardTitle>Archive</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="signal-archive-list">
          {sorted.map((date) => (
            <li key={date}>
              <button type="button" onClick={() => props.onOpen(date)}>
                {new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}
              </button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
