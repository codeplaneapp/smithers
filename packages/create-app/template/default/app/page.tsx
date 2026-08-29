/**
 * The root page. `app/page.tsx` is the route `/`; `app/settings/page.tsx` would
 * be `/settings`. Nothing registers a page but its location.
 *
 * The composer posts to `/api/turn`, which the Worker answers with the NDJSON
 * turn stream. This template renders the assistant text and leaves the cards to
 * a pane host you add when you have panes worth showing.
 */
import { useState } from "react"

export default function Page() {
  const [message, setMessage] = useState("")
  const [answer, setAnswer] = useState<string | undefined>(undefined)
  const [pending, setPending] = useState(false)

  const send = async () => {
    if (message.trim() === "") return
    setPending(true)
    setAnswer(undefined)
    try {
      const response = await fetch("/api/turn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ flow: "chat", payload: { message } })
      })
      setAnswer(await response.text())
    } catch (cause) {
      setAnswer(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
    }
  }

  return (
    <section className="page">
      <h1>Chat</h1>
      <p className="page-lede">
        One flow, one pane, one tool. Edit <code>flows/chat/flow.ts</code> to change what the agent is asked, and{" "}
        <code>AGENT.ts</code> to change the seat it runs on.
      </p>
      <div className="composer">
        <input
          className="composer-input"
          value={message}
          placeholder="Ask something"
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void send()
          }}
        />
        <button className="composer-send" type="button" disabled={pending} onClick={() => void send()}>
          {pending ? "Running" : "Send"}
        </button>
      </div>
      {answer === undefined ? null : <pre className="answer">{answer}</pre>}
    </section>
  )
}
