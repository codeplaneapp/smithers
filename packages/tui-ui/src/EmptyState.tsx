/** @jsxImportSource @opentui/react */

export type EmptyStateProps = {
  title: string;
  description?: string;
};

/** The lines an EmptyState renders. Pure so the layout is testable without a TTY. */
export function emptyStateLines({ title, description }: EmptyStateProps): string[] {
  return description ? [title, description] : [title];
}

/** Centered zero-data placeholder, mirroring `@smithers-orchestrator/ui`'s EmptyState. */
export function EmptyState(props: EmptyStateProps) {
  const lines = emptyStateLines(props);
  return (
    <box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1}>
      {lines.map((line, index) => (
        <text key={line} fg={index === 0 ? "#cccccc" : "#888888"}>
          {line}
        </text>
      ))}
    </box>
  );
}
