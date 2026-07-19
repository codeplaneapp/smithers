/** @jsxImportSource react */
import type { CSSProperties, ReactNode } from "react";
import { useGatewayNodeOutput } from "@smithers-orchestrator/gateway-react";
import { formatOutput, unwrapNodeOutput, type NodeOutputStatus } from "./NodeOutputView";
import { theme } from "./theme";

/** State handed to a {@link NodeOutputCard} body render prop alongside the row. */
export type NodeOutputCardBodyState = {
  /** The resolved envelope bucket (`pending` while loading, `failed` on error). */
  status: NodeOutputStatus;
  /** True until the first envelope arrives from the gateway. */
  loading: boolean;
  /** The fetch error, if the node-output request rejected. */
  error: Error | undefined;
};

/**
 * Render the card body from the unwrapped output row. The row is whatever the
 * node produced (envelope already peeled by {@link unwrapNodeOutput}) — commonly
 * `{ output, summary, ok, ... }` — and is `null` while pending/failed.
 */
export type NodeOutputCardBody = (row: unknown, state: NodeOutputCardBodyState) => ReactNode;

export type NodeOutputCardProps = {
  /** The run to read from. */
  runId: string | undefined;
  /** The node whose output to show. */
  nodeId: string | undefined;
  /** Loop/retry attempt to read (default 0). */
  iteration?: number;
  /** Card heading. Defaults to the `nodeId` (or a generic label). */
  title?: ReactNode;
  /** Secondary line under the title. Defaults to the humanized status. */
  summary?: ReactNode;
  /**
   * Body render prop given the unwrapped row + status. Equivalent to passing a
   * function as `children`; if both are set, `children` wins. When neither is
   * provided the card falls back to a {@link NodeOutputView}-style formatted dump.
   */
  body?: NodeOutputCardBody;
  /** Function-as-children form of {@link NodeOutputCardProps.body}. */
  children?: NodeOutputCardBody;
  /**
   * Bump this to force a remount (fresh fetch + reset any body state) when the
   * surrounding run advances — the `key={remountKey + ":" + nodeId}` convention
   * every hand-rolled output card re-implements, folded in here.
   */
  remountKey?: string | number;
  className?: string;
  style?: CSSProperties;
  /**
   * Test seam: the node-output hook to read from. Defaults to
   * {@link useGatewayNodeOutput}. Injectable so pending/produced/failed chrome
   * can be driven deterministically without racing a live fetch.
   * @internal
   */
  useNodeOutput?: typeof useGatewayNodeOutput;
};

const STATUS_GLYPH: Record<NodeOutputStatus, { glyph: string; color: string; label: string }> = {
  pending: { glyph: "○", color: theme.warning, label: "Pending" },
  produced: { glyph: "✓", color: theme.success, label: "Produced" },
  failed: { glyph: "✕", color: theme.danger, label: "Failed" },
};

/**
 * A run-aware output card: binds to a node via `runId`/`nodeId` through
 * {@link useGatewayNodeOutput}, wraps it in card chrome with an ok/fail/pending
 * status glyph, and renders its body from a render prop given the unwrapped row.
 * Composes {@link NodeOutputView}'s envelope handling ({@link unwrapNodeOutput} /
 * {@link formatOutput}) so callers stop re-implementing the unwrap + remount-key
 * convention across workflow UIs.
 *
 * @example
 * <NodeOutputCard runId={runId} nodeId="run-summary" title="Run summary">
 *   {(row) => <p>{String((row as { summary?: string })?.summary ?? "—")}</p>}
 * </NodeOutputCard>
 */
export function NodeOutputCard({ remountKey, nodeId, ...rest }: NodeOutputCardProps) {
  // Remount on key change (matching the `key={remountKey + ":" + nodeId}`
  // convention) so a fresh fetch runs and any body-local state resets. A
  // component can't set its own key, so delegate to an inner component.
  return (
    <NodeOutputCardInner
      key={remountKey === undefined ? undefined : `${remountKey}:${nodeId}`}
      nodeId={nodeId}
      {...rest}
    />
  );
}

function NodeOutputCardInner({
  runId,
  nodeId,
  iteration,
  title,
  summary,
  body,
  children,
  className,
  style,
  useNodeOutput = useGatewayNodeOutput,
}: Omit<NodeOutputCardProps, "remountKey">) {
  const { data, loading, error } = useNodeOutput({ runId, nodeId, iteration });
  const { status: envelopeStatus, row } = unwrapNodeOutput(data);
  // Before the first envelope lands (or on error) show pending/failed chrome
  // rather than the "produced" default unwrapNodeOutput gives an empty payload.
  const status: NodeOutputStatus = error
    ? "failed"
    : !nodeId || (loading && data == null)
      ? "pending"
      : envelopeStatus;
  const { glyph, color, label } = STATUS_GLYPH[status];
  const render = typeof children === "function" ? children : body;

  let content: ReactNode;
  if (!nodeId) {
    content = <Muted>Select a node to see its output.</Muted>;
  } else if (error) {
    content = <span style={{ color: theme.danger, fontSize: 13 }}>{error.message}</span>;
  } else if (loading && data == null) {
    content = <Muted>Loading…</Muted>;
  } else if (render) {
    content = render(row, { status, loading, error });
  } else {
    content = (
      <pre
        style={{
          margin: 0,
          overflow: "auto",
          fontFamily: theme.fontMono,
          fontSize: 12,
          color: theme.text,
          whiteSpace: "pre-wrap",
        }}
      >
        {formatOutput(data) || "No output."}
      </pre>
    );
  }

  return (
    <section
      className={className}
      data-status={status}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: 12,
        background: theme.panel,
        border: `1px solid ${theme.border}`,
        borderRadius: theme.radius,
        fontFamily: theme.fontSans,
        color: theme.text,
        ...style,
      }}
    >
      <header style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <span
          aria-label={label}
          title={label}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 18,
            height: 18,
            borderRadius: 999,
            flexShrink: 0,
            fontSize: 12,
            fontWeight: 700,
            color,
            background: `color-mix(in srgb, ${color} 14%, transparent)`,
          }}
        >
          {glyph}
        </span>
        <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {title ?? nodeId ?? "Node output"}
          </span>
          <span style={{ fontSize: 11, color: theme.textDim }}>{summary ?? label}</span>
        </span>
      </header>
      <div style={{ fontSize: 13 }}>{content}</div>
    </section>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <span style={{ color: theme.textDim, fontSize: 13 }}>{children}</span>;
}
