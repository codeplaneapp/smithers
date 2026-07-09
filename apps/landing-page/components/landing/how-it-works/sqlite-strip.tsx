type SqliteStripProps = {
  rowCount: number;
};

export function SqliteStrip({ rowCount }: SqliteStripProps) {
  return (
    <div className="hidden w-24 rounded-lg border border-border bg-background/40 p-2 md:block">
      <p className="font-mono text-[9px] uppercase text-muted-foreground">SQLite</p>
      {Array.from({ length: rowCount }).map((_, i) => (
        <div
          key={i}
          className="mt-1 h-1.5 rounded-sm bg-primary/60 landing-persist"
          style={{ animationDelay: `${i * 80}ms` }}
        />
      ))}
    </div>
  );
}
