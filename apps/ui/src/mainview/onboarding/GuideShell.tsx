import { SidebarRepositoryPicker } from "../Composer"
import { guideForwardAction } from "./navigation"
import { useLiveQuery } from "@tanstack/react-db"
import { createContext, Fragment, useRef, useState, type ReactNode, type CSSProperties } from "react"
import {
  BookOpen,
  Check,
  ChevronLeft,
  Command,
  GitPullRequest,
  History,
  Library,
  Sparkles,
  Volume2,
  VolumeX,
  X,
} from "lucide-react"
import { useController } from "../ControllerContext"
import { initialGuide } from "../state/AppState"
import "./guide.css"

/*
 * Where the summoned composer goes. The guide renders the app full-screen
 * with the composer hidden; Command-K summons ONLY the composer into the
 * transparent overlay — the chat history stays in the full-screen UI.
 * `undefined` outside the guide (the bare app keeps its docked composer),
 * null while the conversation is closed, the portal host element once open.
 */
export const GuideComposerHost = createContext<HTMLDivElement | null | undefined>(undefined)

const WORDMARK = [
  "███████╗███╗   ███╗██╗████████╗██╗  ██╗███████╗██████╗ ███████╗",
  "██╔════╝████╗ ████║██║╚══██╔══╝██║  ██║██╔════╝██╔══██╗██╔════╝",
  "███████╗██╔████╔██║██║   ██║   ███████║█████╗  ██████╔╝███████╗",
  "╚════██║██║╚██╔╝██║██║   ██║   ██╔══██║██╔══╝  ██╔══██╗╚════██║",
  "███████║██║ ╚═╝ ██║██║   ██║   ██║  ██║███████╗██║  ██║███████║",
  "╚══════╝╚═╝     ╚═╝╚═╝╚═╝   ╚═╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚══════╝",
]
const lessons = [
  "Hello. I’m Smithers. Let me show how Smithers works",
  "I can speak to you normally like this, in a normal chat message. Whenever this soft glow appears, it means I’m controlling that part of your workspace.",
  "I can send you notifications from time to time, like this. You don’t need to watch every flow to know what’s happening.",
  "I can talk to you with UI widgets, too. Here’s a small form so I can get to know you. Everything here is optional.",
  "But the coolest thing I can do is run flows. Flows are instructions that can be executed to get work done. Everything in this app is modeled as a flow.",
  "Some flows are simple, like changing from light mode to dark mode. Watch the whole workspace.",
  "Or back to light mode. That’s a real change to your app, made through a flow. The same idea scales all the way up to building a feature.",
  "Your work gets the whole window. I’ll stay out of the way until you call me. Press ⌘K (or Ctrl K) to bring me back.",
  "Plugins give this workspace its abilities. Start with the Library: a place to discover the flows and specialists you want to work with.",
  "The Librarian learns a codebase and makes it easier for both of us to understand. Add it, and I’ll walk you through its first two background flows.",
  "On your codebase, the Librarian will ask to build a wiki and a mythical history in the background. You can inspect either run while you work. Let’s rehearse that in a small practice project.",
  "Before committing to an implementation, we try the idea. Here’s our little idea board. This prototype is disposable; what we learn is what we keep.",
  "Change the heading below. You’ll see the prototype update immediately. When it feels right, we’ll carry your feedback into the real plan.",
  "We keep your feedback, discard the prototype code, and plan the implementation with hindsight. A logical Change groups the atomic changes. Mythical history puts stable foundations first.",
  "Implementation, review, and checks come first. When you say it feels right, cleanup turns the accepted work into append-only main history. Delivery can then open a real PR.",
  "You’ve met flows, plugins, and the path from a quick idea to a reviewed change. I’ll sometimes suggest new flows that could help. You decide what to add.",
] as const

/** An original, short opt-in interval; no autoplay or copyrighted game audio. */
function chime() {
  if (typeof AudioContext === "undefined") return
  const audio = new AudioContext()
  void audio
    .resume()
    .then(() => {
      for (const [i, frequency] of [261.63, 392, 523.25].entries()) {
        const tone = audio.createOscillator(),
          gain = audio.createGain(),
          at = audio.currentTime + i * 0.13
        tone.type = "sine"
        tone.frequency.value = frequency
        gain.gain.setValueAtTime(0, at)
        gain.gain.linearRampToValueAtTime(0.035, at + 0.04)
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.8)
        tone.connect(gain).connect(audio.destination)
        tone.start(at)
        tone.stop(at + 0.85)
      }
      setTimeout(() => {
        void audio.close()
      }, 1400)
    })
    .catch(() => {
      void audio.close()
    })
}

export function GuideShell({ children }: { children: ReactNode }) {
  const controller = useController()
  const { data: sessions } = useLiveQuery(controller.store.collections.sessions)
  const { data: toasts } = useLiveQuery(controller.store.collections.toasts)
  const guide = sessions[0]?.guide ?? initialGuide()
  const stage = guide.step
  const lastScrolledStep = useRef(-1)
  const transcriptRef = useRef<HTMLDivElement>(null)
  /* The portal host the summoned composer renders into; null while closed. */
  const [composerHost, setComposerHost] = useState<HTMLDivElement | null>(null)
  /*
   * Only a message that mounts AT the current stage enters with the open
   * animation — Back rewinds the history and an earlier message becoming
   * current again must not re-enter.
   */
  const enteredStep = useRef(-1)
  if (stage > enteredStep.current) enteredStep.current = stage
  const opener = useRef<HTMLButtonElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  // Transient save acknowledgement only; field values and progression live in the store.
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "failed">("idle")
  const saveSequence = useRef(0)
  const runCommandGuide = (action: string, value?: string) => {
    const args = `${action}${value === undefined ? "" : ` ${JSON.stringify(value)}`}`
    if (action === "next" && stage === 3) {
      const sequence = ++saveSequence.current
      setSaveStatus("saving")
      void controller.commands.run("onboarding.act", args).then(
        (outcome) => {
          if (saveSequence.current === sequence)
            setSaveStatus(outcome.status === "executed" ? "saved" : "failed")
        },
        () => {
          if (saveSequence.current === sequence) setSaveStatus("failed")
        },
      )
    } else controller.runCommandArgs("onboarding.act", args)
    if (guide.sound && !["title", "heard", "project", "close"].includes(action)) chime()
  }
  const runCommandOpen = () => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    runCommandGuide("open")
    requestAnimationFrame(() =>
      document.querySelector<HTMLTextAreaElement>(".guide-composer-layer textarea")?.focus(),
    )
  }
  const runCommandClose = () => {
    runCommandGuide("close")
    requestAnimationFrame(() => {
      if (previousFocus.current?.isConnected) previousFocus.current.focus()
      else (opener.current ?? document.querySelector<HTMLElement>(".guide-shell"))?.focus()
    })
  }
  const runCommandLive = (name: string) => {
    runCommandOpen()
    if (!controller.runCommand(name)) controller.send(`/${name}`)
  }
  const runCommandNext = () => runCommandGuide("next")
  const runCommandSound = () => {
    runCommandGuide("sound")
    if (!guide.sound) chime()
  }
  const keyHint = (keys = "↵ Enter") => (
    <kbd className="guide-button-key" aria-hidden="true" title={keys === "Tab ↵" ? "Tab to this button, then press Enter" : undefined}>{keys}</kbd>
  )
  const primary = (label: string, action = "next") => (
    <button
      className="guide-primary"
      data-flow="onboarding.act"
      data-action={action}
      aria-keyshortcuts="Enter ArrowRight"
      onClick={() => runCommandGuide(action)}
    >
      {label}
      {keyHint()}
    </button>
  )
  return (
    <GuideComposerHost.Provider value={composerHost}>
    <div
      key={guide.playthrough ?? 0}
      className="guide-shell"
      data-flows={controller.commands
        .all()
        .map((command) => command.name)
        .join(" ")}
      data-step={stage}
      data-theme={sessions[0]?.theme ?? "light"}
      tabIndex={-1}
      ref={(node) => {
        if (!node) return
        if (document.activeElement === document.body) node.focus()
        // The composer is portaled and focus can fall back to the document.
        // Shell dismissal must work even when the key has no React ancestor.
        const onKeyDown = (event: globalThis.KeyboardEvent) => {
          if (event.isComposing) return
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
            event.preventDefault()
            event.stopPropagation()
            guide.conversationOpen ? runCommandClose() : runCommandOpen()
          } else if (event.key === "Escape" && guide.conversationOpen) {
            event.preventDefault()
            event.stopPropagation()
            runCommandClose()
          }
        }
        document.addEventListener("keydown", onKeyDown, true)
        return () => document.removeEventListener("keydown", onKeyDown, true)
      }}
      onKeyDownCapture={(event) => {
        if (event.nativeEvent.isComposing) return
        if (
          !guide.conversationOpen &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey &&
          !event.shiftKey
        ) {
          const target = event.target instanceof Element ? event.target : null
          // Text editing retains arrows/Enter. Enter on a focused button retains its native action.
          if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
          if (event.key.toLowerCase() === "s") {
            event.preventDefault()
            if (!event.repeat) runCommandSound()
            return
          }
          if (event.key === "Enter" && target?.closest("button, a")) return
          if (stage === 4 && event.key.toLowerCase() === "r") {
            event.preventDefault()
            if (!event.repeat) runCommandGuide("wait-flow")
          } else if (stage === 2 && event.key.toLowerCase() === "n") {
            event.preventDefault()
            if (!event.repeat) runCommandGuide("notify")
          } else if (event.key === "ArrowRight" || event.key === "Enter") {
            event.preventDefault()
            if (event.repeat) return
            if (stage === 7 || stage === 15) runCommandOpen()
            else runCommandGuide(guideForwardAction(stage))
          } else if (event.key === "ArrowLeft" && stage > 0) {
            event.preventDefault()
            if (!event.repeat) runCommandGuide("back")
          }
        }
      }}
    >
      {
        /*
         * The app IS the default view: full-screen, without a composer. The
         * guide chrome covers it during the lessons; at the workspace step the
         * chrome steps aside (guide.css) and the app takes the window. The
         * composer itself is summoned into the transparent Command-K overlay.
         */
      }
      <div className="guide-app" inert={guide.conversationOpen ? true : undefined}>
        {children}
      </div>
      <div className="guide-atmosphere" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
      <header className="guide-header">
        <span className="guide-location">
          {stage < 8 ? "" : stage < 15 ? "Your first adventure" : "Your workspace"}
        </span>
        <div className="guide-wordmark" aria-label="Smithers">
          <pre aria-hidden="true">
            {WORDMARK.map((line, i) => (
              <span key={i} style={{ "--row": i } as CSSProperties}>
                {line}
                {"\n"}
              </span>
            ))}
          </pre>
        </div>
      </header>
      <aside className="guide-sidebar" aria-label="Workspace sidebar">
        <SidebarRepositoryPicker />
      {guide.library && (
        <nav aria-label="Installed capabilities">
          <span className="guide-section-label">YOUR PLUGINS</span>
          <button data-flow="flows" onClick={() => runCommandLive("flows")}>
            <Library size={17} />
            Library {keyHint("Tab ↵")}
            <span className="guide-plugin-dot" />
          </button>
          {guide.librarian && (
            <>
              <button data-flow="wiki" onClick={() => runCommandLive("wiki")}>
                <BookOpen size={17} />
                Wiki {keyHint("Tab ↵")}
              </button>
              <button data-flow="history.show" onClick={() => runCommandLive("history.show")}>
                <History size={17} />
                Mythical history {keyHint("Tab ↵")}
              </button>
            </>
          )}
          <p>
            Capabilities appear
            <br />
            as you add them.
          </p>
        </nav>
      )}
      </aside>
      <main className="guide-main" inert={guide.conversationOpen ? true : undefined}>
        <section className="guide-lesson" aria-label={`Lesson ${stage + 1}`}>
          <div
            className="guide-transcript"
            role="log"
            aria-label="Onboarding chat history"
            aria-live="polite"
            aria-relevant="additions"
            tabIndex={0}
            ref={(node) => {
              transcriptRef.current = node
              if (node && lastScrolledStep.current !== stage) {
                lastScrolledStep.current = stage
                requestAnimationFrame(() => { node.scrollTo({ top: node.scrollHeight }) })
              }
            }}
          >
            {lessons.slice(0, stage + 1).map((message, messageStep) => (
              <div
                key={messageStep}
                className="guide-message"
                data-enter={messageStep === stage && messageStep === enteredStep.current}
                onAnimationEnd={(event) => {
                  /* The open grows the history: settle the scroll at the bottom. */
                  if (event.target !== event.currentTarget) return
                  transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight })
                }}
              >
                <article
                  className="guide-dialogue smithers-control"
                  data-message-step={messageStep}
                  data-current={messageStep === stage}
                  data-controlled={messageStep === stage && (stage < 7 || stage === 10)}
                >
                  <div className="guide-speaker"><span />SMITHERS</div>
                  <p>
                    {message.split(" ").map((word, index, words) => {
                      const pauses = words.slice(0, index).filter(part => /[.!?]$/.test(part)).length
                      return <span key={index} className="guide-word" style={{ "--word-delay": `${index * .03 + pauses * .12}s` } as CSSProperties}>{word}{" "}</span>
                    })}
                  </p>
                </article>
              </div>
            ))}
          </div>
          {stage === 3 && (
            <form
              id="guide-profile"
              className="guide-form"
              onSubmit={(event) => {
                event.preventDefault()
                runCommandNext()
              }}
            >
              <label>
                How did you hear about Smithers?
                <input
                  data-saved-value={guide.heard}
                  value={guide.heard}
                  onChange={(event) => runCommandGuide("heard", event.target.value)}
                  placeholder="A friend, a post, a happy accident…"
                  maxLength={500}
                />
              </label>
              <label>
                What would you love to build?
                <input
                  value={guide.project}
                  onChange={(event) => runCommandGuide("project", event.target.value)}
                  placeholder="A small idea is a great place to start"
                  maxLength={500}
                />
              </label>
              <p role="status">
                {saveStatus === "saving"
                  ? "Saving…"
                  : saveStatus === "saved"
                    ? "Saved."
                    : saveStatus === "failed"
                      ? "Your answer could not be saved. Please try again."
                      : "Answers are optional and shared with the Smithers team when you continue."}
              </p>
            </form>
          )}
          {(stage === 8 || stage === 9) && (
            <div className="guide-plugin-card">
              <div className="guide-plugin-icon">{stage === 8 ? <Library /> : <BookOpen />}</div>
              <div>
                <h2>{stage === 8 ? "Library" : "Librarian"}</h2>
                <p>
                  {stage === 8 ? "Discover a new way to work." : "A guide to your codebase, always learning."}
                </p>
                <small>
                  {stage === 8
                    ? "Adds the plugin shelf to your workspace"
                    : "Introduces Wiki + Mythical history"}
                </small>
              </div>
              <span className="guide-tag">FIRST PARTY</span>
            </div>
          )}
          {stage >= 8 && stage <= 14 && (
            <p className="guide-practice-note">
              ONBOARDING PREVIEW · Plugin activation is local. Repository runs begin only when you launch
              them.
            </p>
          )}
          {stage === 10 && (
            <div className="guide-background-flows">
              {[
                [BookOpen, "Build the wiki", "Read the code → connect concepts → write a living guide"],
                [
                  History,
                  "Tell the mythical history",
                  "Find foundations → order changes → explain the architecture",
                ],
              ].map(([Icon, label, detail]) => {
                const Glyph = Icon as typeof BookOpen
                return (
                  <div key={String(label)} className="smithers-control" data-controlled="true">
                    <Glyph size={20} />
                    <div>
                      <strong>{String(label)}</strong>
                      <p>{String(detail)}</p>
                    </div>
                    <span className="guide-tag">PREVIEW</span>
                  </div>
                )
              })}
              <p>These are the two proposed flows. No codebase is being processed in this rehearsal.</p>
            </div>
          )}
          {(stage === 11 || stage === 12) && (
            <div className="guide-prototype smithers-control" data-controlled={stage === 11}>
              <div className="guide-artifact-bar">
                <span>
                  <span className="guide-status-dot" />
                  POC / idea-board
                </span>
                <span>LIVE LOCAL PREVIEW</span>
              </div>
              <div className="guide-board">
                <span className="guide-board-overline">THE IDEA GARDEN</span>
                <h2>{guide.prototypeTitle || "Your next idea starts here"}</h2>
                <div className="guide-board-cards">
                  {["A spark", "A little experiment", "Something worth keeping"].map((item, i) => (
                    <article key={item} style={{ "--card": i } as CSSProperties}>
                      <span>0{i + 1}</span>
                      <h3>{item}</h3>
                      <p>
                        {
                          [
                            "What if we tried something new?",
                            "Make it small. Make it tangible.",
                            "Keep the lesson. Grow the idea.",
                          ][i]
                        }
                      </p>
                    </article>
                  ))}
                </div>
              </div>
              {stage === 12 && (
                <label className="guide-edit-label">
                  Edit the heading
                  <input
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                        event.preventDefault()
                        runCommandGuide("revise")
                      }
                    }}
                    aria-label="Prototype heading"
                    value={guide.prototypeTitle}
                    maxLength={100}
                    onChange={(event) => runCommandGuide("title", event.target.value)}
                  />
                </label>
              )}
            </div>
          )}
          {stage === 13 && (
            <div className="guide-history">
              <div className="guide-artifact-bar">
                <span>MYTH / practice change</span>
                <span>LOCAL REHEARSAL</span>
              </div>
              {[
                ["01", "Foundation", "Define the board and its idea model"],
                ["02", "Presentation", guide.prototypeTitle],
                ["03", "Verification", "Check the accepted revision, then review"],
              ].map(([n, heading, description]) => (
                <div className="guide-history-row" key={n}>
                  <span>{n}</span>
                  <div>
                    <strong>{heading}</strong>
                    <p>{description}</p>
                  </div>
                  {n === "02" && <span className="guide-tag">AMENDED</span>}
                </div>
              ))}
              <p className="guide-artifact-foot">
                Your feedback is carried into this practice plan. Your repository hasn’t changed.
              </p>
            </div>
          )}
          {stage === 14 && (
            <div className="guide-pr">
              <GitPullRequest size={22} />
              <div>
                <h2>Add the idea garden</h2>
                <p>{guide.prototypeTitle}</p>
                <div className="guide-pr-steps">
                  <span>Implement</span>
                  <span>Review + checks</span>
                  <span>Vibed</span>
                  <span>Cleanup + deliver</span>
                </div>
                <div className="guide-review-diff" aria-label="Practice heading change">
                  <span>Heading before</span>
                  <del>A little room for big ideas</del>
                  <span>Your proposed heading</span>
                  <ins>{guide.prototypeTitle}</ins>
                </div>
                <p className="guide-review-explanation">Review the direction you chose. You can go back and refine it before accepting this practice change.</p>
                <button className="guide-text-button" data-flow="onboarding.act" onClick={() => runCommandGuide("request-changes")}>
                  I’d like to change something {keyHint("Tab ↵")}
                </button>
                <small>Practice PR preview · nothing has been pushed or published.</small>
              </div>
            </div>
          )}
          {
            /*
             * The actions are ONE stable row: a new lesson message appends
             * above it and the row just moves with the layout — the controls
             * never re-animate or trade places with a retiring copy.
             */
          }
          {stage === 15 && (
            <div className="guide-start-actions">
              {guide.acceptedPracticeTitle && <p className="guide-review-accepted"><Check size={14} /> Practice accepted: “{guide.acceptedPracticeTitle}”</p>}
              <button className="guide-primary" data-flow="connect" onClick={() => runCommandLive("connect")}>
                Choose a repository
                {keyHint("Tab ↵")}
              </button>
              <button
                className="guide-secondary"
                data-flow="feature.prototype"
                onClick={() => runCommandLive("feature.prototype")}
              >
                Start a real prototype
                {keyHint("Tab ↵")}
              </button>
              <p>
                Sign in when requested. Real runs show their actual progress and any missing setup in the
                conversation.
              </p>
            </div>
          )}
          <div className="guide-actions">
            {
              /*
               * The buttons of the next step are DIFFERENT controls, keyed by
               * step so reconciliation swaps the activated node out instead of
               * morphing it in place: a pointer click that advances into the
               * profile lesson must not let the browser's activation behavior
               * submit the freshly-mounted form the same gesture became (one
               * click was advancing 2 → 3 → 4 in a single gesture).
               */
            }
            <Fragment key={stage}>
            {stage === 2 && (
              <button className="guide-text-button" aria-keyshortcuts="N" data-flow="onboarding.act" onClick={() => runCommandGuide("notify")}>
                Send me a notification {keyHint("N")}
              </button>
            )}
            {stage === 4 && (
              <div className="guide-flow-example">
                <button className="guide-secondary" data-flow="onboarding.act" aria-keyshortcuts="R" disabled={guide.demoRun?.status === "running"} onClick={() => runCommandGuide("wait-flow")}>
                  Run a flow {keyHint("R")}
                </button>
                <p role="status" aria-live="polite">
                  {guide.demoRun?.status === "running" ? "Running · waiting 5 seconds…" : guide.demoRun?.status === "succeeded" ? "Finished successfully." : guide.demoRun?.status === "interrupted" ? "The example was interrupted. Run it again." : "Wait 5 seconds, then finish."}
                </p>
              </div>
            )}
            {stage === 3 ? (
              <button type="submit" form="guide-profile" aria-keyshortcuts="Enter ArrowRight" className="guide-primary" data-flow="onboarding.act">
                Continue, with or without answers {keyHint()}
              </button>
            ) : stage === 5 ? (
              primary("Run dark-mode flow", "dark")
            ) : stage === 6 ? (
              primary("Bring back the light", "light")
            ) : stage === 7 ? (
              <button
                ref={opener}
                className="guide-primary"
                aria-keyshortcuts="Meta+k Control+k Enter ArrowRight"
                data-flow="onboarding.act"
                onClick={runCommandOpen}
              >
                <span>Call Smithers</span>
                {keyHint("⌘ K")}
                {keyHint()}
              </button>
            ) : stage === 8 ? (
              primary("Install Library", "library")
            ) : stage === 9 ? (
              primary("Add Librarian", "librarian")
            ) : stage === 12 ? (
              primary("Keep this direction", "revise")
            ) : stage === 14 ? (
              primary("Accept practice change", "accept-practice")
            ) : stage === 15 ? null : (
              primary(
                stage === 0
                  ? "Let’s begin"
                  : stage === 3
                    ? "Continue, with or without answers"
                    : stage === 10
                      ? "Let’s make something"
                      : stage === 11
                        ? "Try editing it"
                        : stage === 13
                          ? "See the path to a PR"
                          : stage === 14
                            ? "Take me to my workspace"
                            : "Continue",
              )
            )}
            {stage > 0 && stage < 15 && (
              <button
                className="guide-back"
                aria-keyshortcuts="ArrowLeft"
                data-flow="onboarding.act"
                onClick={() => runCommandGuide("back")}
              >
                <ChevronLeft size={13} />
                Back {keyHint("←")}
              </button>
            )}
            </Fragment>
          </div>
        </section>
      </main>
      <footer className="guide-footer">
        <button
          data-flow="onboarding.act"
          onClick={runCommandSound}
          aria-keyshortcuts="s"
          aria-label={guide.sound ? "Mute tutorial sounds" : "Enable tutorial sounds"}
        >
          {guide.sound ? <Volume2 size={15} /> : <VolumeX size={15} />}
          <span>Sound {guide.sound ? "on" : "off"}</span>
          {keyHint("S")}
        </button>
        <div className="guide-progress" aria-label={`Lesson ${stage + 1} of 16`}>
          {Array.from({ length: 16 }, (_, i) => (
            <span key={i} data-passed={i <= stage} />
          ))}
        </div>
        {stage >= 7 && (
          <button ref={opener} data-flow="onboarding.act" onClick={runCommandOpen}>
            <Command size={14} />
            <span>Talk to Smithers</span>
            {keyHint("⌘ K")}
          </button>
        )}
        {stage === 15 && (
          <button data-flow="onboarding.act" onClick={() => runCommandGuide("restart")}>
            Replay introduction {keyHint("Tab ↵")}
          </button>
        )}
      </footer>
      {guide.conversationOpen && (
        <div
          className="guide-composer-backdrop"
          onClick={(event) => {
            if (event.target === event.currentTarget) runCommandClose()
          }}
        >
          {
            /*
             * Command-K summons ONLY the composer: a transparent layer over
             * the content, the composer floating in it. The conversation
             * itself stays in the full-screen UI underneath.
             */
          }
          <section
            className="guide-composer-layer"
            role="dialog"
            aria-modal="true"
            aria-label="Talk to Smithers"
            onKeyDown={(event) => {
              if (event.key !== "Tab") return
              const elements = Array.from(
                event.currentTarget.querySelectorAll<HTMLElement>(
                  'button:not([disabled]), textarea, input, [tabindex="0"]',
                ),
              ).filter((el) => el.getClientRects().length > 0)
              const first = elements[0],
                last = elements.at(-1)
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault()
                last?.focus()
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault()
                first?.focus()
              }
            }}
          >
            <div className="guide-composer-host" ref={setComposerHost} />
          </section>
        </div>
      )}
      {!guide.conversationOpen && toasts.length > 0 && (
        <aside className="guide-toasts" aria-label="Notifications">
          {toasts.map((toast) => (
            <div className="guide-toast" key={toast.id} role="status">
              <Sparkles size={17} />
              <div>
                <strong>{toast.title}</strong>
                <p>{toast.detail}</p>
              </div>
              <button
                aria-label={`Dismiss ${toast.title}`}
                data-flow="toast.dismiss"
                onClick={() => controller.runCommandArgs("toast.dismiss", toast.id)}
              >
                <X size={14} />
                {keyHint("Tab ↵")}
              </button>
            </div>
          ))}
        </aside>
      )}
    </div>
    </GuideComposerHost.Provider>
  )
}
