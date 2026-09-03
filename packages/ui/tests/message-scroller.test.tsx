/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatTranscript } from "../src/index";

describe("ChatTranscript", () => {
  test("composes the scroller and forwards pending streaming state", () => {
    const html = renderToStaticMarkup(<ChatTranscript pending>hello</ChatTranscript>);
    expect(html).toContain('data-slot="message-scroller"');
    expect(html).toContain('data-streaming="true"');
    expect(html).toContain("sui-chat-messages");
  });

  test("renders its empty state when a boolean child collapses to false", () => {
    const messages: string[] = [];
    const html = renderToStaticMarkup(
      <ChatTranscript empty="No messages">
        {messages.length > 0 && messages.map((message) => <div key={message}>{message}</div>)}
      </ChatTranscript>,
    );
    expect(html).toContain("No messages");
    expect(html).toContain("sui-chat-empty");
  });
});
