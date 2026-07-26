import { Badge, SectionHeader, Eyebrow, StatusPill } from "smithers-orchestrator/ui";

export function Masthead(props: {
  date?: string;
  degraded?: boolean;
  onNavigateHome: () => void;
  onNavigateArchive: () => void;
}) {
  return (
    <header className="signal-masthead">
      <div className="signal-masthead-row">
        <button
          type="button"
          className="signal-wordmark"
          onClick={props.onNavigateHome}
          aria-label="The Smithers Signal — home"
        >
          <Eyebrow>Daily intelligence for the agent-orchestration space</Eyebrow>
          <h1>The Smithers Signal</h1>
        </button>
        <nav className="signal-nav">
          <button type="button" onClick={props.onNavigateHome}>
            Today
          </button>
          <button type="button" onClick={props.onNavigateArchive}>
            Archive
          </button>
        </nav>
      </div>
      {props.date ? (
        <SectionHeader
          title={new Date(`${props.date}T12:00:00Z`).toLocaleDateString("en-US", {
            weekday: "long",
            year: "numeric",
            month: "long",
            day: "numeric",
          })}
          actions={
            <>
              {props.degraded ? (
                <StatusPill status="waiting" label="Degraded coverage today" />
              ) : (
                <Badge variant="success">Full coverage</Badge>
              )}
            </>
          }
        />
      ) : null}
    </header>
  );
}
