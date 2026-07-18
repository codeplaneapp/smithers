/** @jsxImportSource react */
export function FailedTaskBadge({ count }: { count: number | undefined }) {
  if (!count || count < 0) return null;
  const title = `${count} failed task${count === 1 ? "" : "s"}`;
  return (
    <span className="mon-badge tone-failed" title={title}>
      {count} failed
    </span>
  );
}
