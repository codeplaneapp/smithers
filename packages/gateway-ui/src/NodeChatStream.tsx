/** @jsxImportSource react */
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useGatewayNodeEvents } from "@smthrs/gateway-react";
import {
  ChatMessage,
  ChatTranscript,
  EmptyState,
  Marker,
  MessageResponse,
  Reasoning,
  StatusPill,
  ToolCall,
} from "@smthrs/ui";
import { buildNodeChatTranscript, type NodeChatItem } from "./nodeChat";
import { theme } from "./theme";

export type NodeChatStreamProps = {
  /** The run to stream from. */
  runId: string | undefined;
  /** The agent node whose durable live chat history to render. */
  nodeId: string | undefined;
  /** Card heading. Defaults to the `nodeId`. */
  title?: ReactNode;
  /** Secondary line under the title, e.g. "opencode · kimi-k3". */
  subtitle?: ReactNode;
  /**
   * Node status for the header pill. When omitted it is derived from the
   * node's lifecycle frames in its indexed event history.
   */
  status?: string;
  /** Scrolling transcript height (default 320). Pass "auto" to grow freely. */
  height?: number | string;
  /** Cap the transcript entries kept (default 200, keeps the tail). */
  maxItems?: number;
  className?: string;
  style?: CSSProperties;
  /**
   * Test seam: the node-events hook to read from. Defaults to
   * {@link useGatewayNodeEvents}.
   * @internal
   */
  useNodeEvents?: typeof useGatewayNodeEvents;
};

function ChatItem({ item, streaming }: { item: NodeChatItem; streaming: boolean }) {
  switch (item.kind) {
    case "marker":
      return <Marker>{item.label}</Marker>;
    case "note":
      return <Marker variant="note">{item.label}</Marker>;
    case "text":
      return (
        <ChatMessage role="assistant">
          <MessageResponse content={item.text} streaming={streaming} />
        </ChatMessage>
      );
    case "stderr":
      return (
        <ChatMessage role="assistant" variant="terminal">
          {item.text}
        </ChatMessage>
      );
    case "reasoning":
      return (
        <Reasoning streaming={streaming} defaultOpen={false}>
          <MessageResponse content={item.text} streaming={streaming} />
        </Reasoning>
      );
    case "tool":
      return (
        <ToolCall
          name={item.call.name}
          state={item.call.state}
          argsText={item.call.argsText}
          resultText={item.call.resultText}
          layout="compact"
        />
      );
  }
}

/**
 * Live agent chat for one node — the "what is this agent actually doing right
 * now" card every run dashboard needs next to its status pills. Loads durable
 * node-filtered history and polls its sequence cursor, then folds the node's
 * stdout/stderr chunks, tool calls, reasoning, and file-change actions into a
 * chat transcript (see `buildNodeChatTranscript`), and follows the tail while
 * the node is running.
 *
 * Use one per agent node in a detail pane; deterministic nodes (typecheck,
 * commit) usually want {@link NodeOutputCard} instead.
 *
 * @example
 * <NodeChatStream
 *   runId={runId}
 *   nodeId={`${item}:implement`}
 *   title="Implement"
 *   subtitle="opencode · kimi-k3"
 *   status={statuses.get(`${item}:implement`)}
 * />
 */
export function NodeChatStream({
  runId,
  nodeId,
  title,
  subtitle,
  status,
  height = 320,
  maxItems,
  className,
  style,
  useNodeEvents = useGatewayNodeEvents,
}: NodeChatStreamProps) {
  const { events, error, loading } = useNodeEvents(runId, nodeId);
  const [dismissedError, setDismissedError] = useState<string>();
  useEffect(() => {
    if (!error) setDismissedError(undefined);
  }, [error]);
  const transcript = useMemo(
    () =>
      nodeId
        ? buildNodeChatTranscript(events, nodeId, { maxItems })
        : { items: [], status: undefined, engine: undefined, streaming: false },
    [events, nodeId, maxItems],
  );
  const resolvedStatus = status ?? transcript.status;
  const streaming = status !== undefined ? status === "running" : transcript.streaming;
  const lastKey = transcript.items[transcript.items.length - 1]?.key;

  let body: ReactNode;
  if (!runId || !nodeId) {
    body = <EmptyState title="No node selected" description="Pick an agent node to follow its chat." />;
  } else if (error && transcript.items.length === 0) {
    body = <EmptyState title="Chat stream failed" description={error.message} />;
  } else if (transcript.items.length === 0) {
    body = loading ? (
      <EmptyState description="Loading chat…" />
    ) : (
      <EmptyState
        title={streaming ? "Agent starting…" : "No agent output yet"}
        description={
          streaming ? "Waiting for the first chunk from the agent." : "This node has not produced chat output."
        }
      />
    );
  } else {
    body = (
      <ChatTranscript
        pending={streaming && transcript.items[transcript.items.length - 1]?.kind !== "text"}
        style={{ height, minHeight: 0 }}
      >
        {transcript.items.map((item) => (
          <ChatItem key={item.key} item={item} streaming={streaming && item.key === lastKey} />
        ))}
      </ChatTranscript>
    );
  }

  return (
    <section
      className={className}
      data-slot="node-chat-stream"
      data-status={resolvedStatus}
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
        <span style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {title ?? nodeId ?? "Agent chat"}
          </span>
          {subtitle || transcript.engine ? (
            <span style={{ fontSize: 11, color: theme.textDim }}>{subtitle ?? transcript.engine}</span>
          ) : null}
        </span>
        <StatusPill status={resolvedStatus ?? "pending"} />
      </header>
      {body}
      {error && transcript.items.length > 0 && error.message !== dismissedError ? (
        <div
          data-slot="node-chat-stream-error"
          role="alert"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 8px",
            border: `1px solid ${theme.dangerBorder}`,
            borderRadius: 6,
            background: theme.dangerSoft,
            color: theme.danger,
            fontSize: 12,
          }}
        >
          <span style={{ flex: 1, minWidth: 0 }}>Chat stream interrupted. {error.message}</span>
          <button
            type="button"
            aria-label="Dismiss chat stream error"
            onClick={() => setDismissedError(error.message)}
            style={{
              padding: "1px 5px",
              border: `1px solid ${theme.dangerBorder}`,
              borderRadius: 4,
              background: "transparent",
              color: "inherit",
              cursor: "pointer",
            }}
          >
            ×
          </button>
        </div>
      ) : null}
    </section>
  );
}
