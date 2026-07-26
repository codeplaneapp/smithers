import { CardView } from "../cards/CardView";
import { Markdown } from "./Markdown";
import { useChatStore } from "./chatStore";

/**
 * The scrolling conversation, shared by the bottom-dock view and the sidebar
 * rail. Reads the chat store; the store registers this element (via the ref
 * callback) so its actions can auto-scroll after a paint without an effect.
 */
export function ChatTranscript({ anonymous = false }: { anonymous?: boolean }) {
  const messages = useChatStore((state) => state.messages);
  const pending = useChatStore((state) => state.pending);
  const streaming = useChatStore((state) => state.streaming);
  const registerConversation = useChatStore((state) => state.registerConversation);
  const isAskMe = false;

  return (
    <div
      className="conversation"
      ref={registerConversation}
      role="log"
      // role=log already implies aria-live="polite". aria-busy holds
      // announcements while a reply streams so a screen reader reads the finished
      // message once instead of re-announcing on every token.
      aria-busy={pending || streaming}
    >
      <div className="messages">
        {messages.length === 0 && isAskMe ? (
          <p className="askme-hint">
            {anonymous
              ? "Ask a question about Smithers — type it and hit Enter."
              : "Tell me what to grill you on — type a topic and hit Enter."}
          </p>
        ) : null}
        {messages.map((message) => (
          <div className={`message ${message.role}`} key={message.id}>
            {message.text ? (
              <div className="bubble">
                {message.role === "assistant" ? <Markdown content={message.text} /> : message.text}
              </div>
            ) : null}
            {message.card ? <CardView card={message.card} /> : null}
          </div>
        ))}
        {pending ? (
          <div className="message assistant">
            <div className="bubble typing" aria-label="Smithers is thinking">
              <span />
              <span />
              <span />
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
