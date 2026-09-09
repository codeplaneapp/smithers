import { guideForwardAction } from "./navigation"
import { useLiveQuery } from "@tanstack/react-db"
import { useRef, useState, type ReactNode, type CSSProperties } from "react"
import {
  ArrowRight,
  BookOpen,
  Check,
  ChevronLeft,
  Command,
  GitPullRequest,
  History,
  Library,
  Moon,
  Sparkles,
  Sun,
  Volume2,
  VolumeX,
  X,
} from "lucide-react"
import { useController } from "../ControllerContext"
import { initialGuide } from "../state/AppState"
import "./guide.css"

const WORDMARK = [
  "███████╗███╗   ███╗██╗████████╗██╗  ██╗███████╗██████╗ ███████╗",
  "██╔════╝████╗ ████║██║╚══██╔══╝██║  ██║██╔════╝██╔══██╗██╔════╝",
  "███████╗██╔████╔██║██║   ██║   ███████║█████╗  ██████╔╝███████╗",
  "╚════██║██║╚██╔╝██║██║   ██║   ██╔══██║██╔══╝  ██╔══██╗╚════██║",
  "███████║██║ ╚═╝ ██║██║   ██║   ██║  ██║███████╗██║  ██║███████║",
  "╚══════╝╚═╝     ╚═╝╚═╝╚═╝   ╚═╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚══════╝",
]
const lessons = [
  [
    "A small beginning",
    "Hello. I’m Smithers.",
    "We’re going to make something together. First, let me show you how we’ll work.",
  ],
  [
    "A conversation",
    "We can just talk.",
    "I can speak to you normally like this, in a normal chat message. Whenever this soft glow appears, it means I’m controlling that part of your workspace.",
  ],
  [
    "A gentle tap on the shoulder",
    "I’ll keep you in the loop.",
    "I can send you notifications from time to time, like this. You don’t need to watch every flow to know what’s happening.",
  ],
  [
    "More than words",
    "Sometimes, a little UI helps.",
    "I can talk to you with UI widgets, too. Here’s a small form so I can get to know you. Everything here is optional.",
  ],
  [
    "The thing that makes it all work",
    "Everything begins with a flow.",
    "But the coolest thing I can do is run flows. Flows are instructions that can be executed to get work done. Everything in this app is modeled as a flow.",
  ],
  [
    "A very small flow",
    "Let’s turn down the lights.",
    "Some flows are simple, like changing from light mode to dark mode. Watch the whole workspace.",
  ],
  [
    "And back again",
    "A little daylight.",
    "Or back to light mode. That’s a real change to your app, made through a flow. The same idea scales all the way up to building a feature.",
  ],
  [
    "Always close by",
    "A conversation, when you need it.",
    "Your work gets the whole window. I’ll stay out of the way until you call me. Press ⌘K (or Ctrl K) to bring me back.",
  ],
  [
    "Make this place your own",
    "Let’s open the Library.",
    "Plugins give this workspace its abilities. Start with the Library: a place to discover the flows and specialists you want to work with.",
  ],
  [
    "Your first specialist",
    "Meet the Librarian.",
    "The Librarian learns a codebase and makes it easier for both of us to understand. Add it, and I’ll walk you through its first two background flows.",
  ],
  [
    "Two things, quietly taking shape",
    "Here’s what happens next.",
    "On your codebase, the Librarian will ask to build a wiki and a mythical history in the background. You can inspect either run while you work. Let’s rehearse that in a small practice project.",
  ],
  [
    "An idea you can touch",
    "First, a quick proof of concept.",
    "Before committing to an implementation, we try the idea. Here’s our little idea board. This prototype is disposable; what we learn is what we keep.",
  ],
  [
    "Make it yours",
    "Try a small change.",
    "Change the heading below. You’ll see the prototype update immediately. When it feels right, we’ll carry your feedback into the real plan.",
  ],
  [
    "From experiment to intention",
    "A better story for the code.",
    "We keep your feedback, discard the prototype code, and plan the implementation with hindsight. A logical Change groups the atomic changes. Mythical history puts stable foundations first.",
  ],
  [
    "The last mile",
    "From a Change to a pull request.",
    "Implementation, review, and checks come first. When you say it feels right, cleanup turns the accepted work into append-only main history. Delivery can then open a real PR.",
  ],
  [
    "Your story starts here",
    "All right. What shall we make?",
    "You’ve met flows, plugins, and the path from a quick idea to a reviewed change. I’ll sometimes suggest new flows that could help. You decide what to add.",
  ],
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
  const [eyebrow, title, body] = lessons[stage]!
  const opener = useRef<HTMLButtonElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  // Transient save acknowledgement only; field values and progression live in the store.
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "failed">("idle")
  const saveSequence = useRef(0)
  const runCommandGuide = (action: string, value?: string) => {
    const args = `${action}${value === undefined ? "" : ` ${JSON.stringify(value)}`}`
    if (["heard", "project", "title"].includes(action)) {
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
      document.querySelector<HTMLTextAreaElement>(".guide-conversation textarea")?.focus(),
    )
  }
  const runCommandClose = () => {
    runCommandGuide("close")
    requestAnimationFrame(() => {
      if (previousFocus.current?.isConnected) previousFocus.current.focus()
      else opener.current?.focus()
    })
  }
  const runCommandLive = (name: string) => {
    runCommandOpen()
    if (!controller.runCommand(name)) controller.send(`/${name}`)
  }
  const runCommandNext = () => runCommandGuide("next")
  const primary = (label: string, action = "next", icon: ReactNode = <ArrowRight size={16} />) => (
    <button
      className="guide-primary"
      data-flow="onboarding.act"
      data-action={action}
      onClick={() => runCommandGuide(action)}
    >
      {label}
      {icon}
    </button>
  )
  return (
    <div
      className="guide-shell"
      data-flows={controller.commands
        .all()
        .map((command) => command.name)
        .join(" ")}
      data-step={stage}
      data-theme={sessions[0]?.theme ?? "light"}
      tabIndex={-1}
      ref={(node) => {
        if (node && document.activeElement === document.body) node.focus()
      }}
      onKeyDownCapture={(event) => {
        if (event.nativeEvent.isComposing) return
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
          event.preventDefault()
          event.stopPropagation()
          guide.conversationOpen ? runCommandClose() : runCommandOpen()
        } else if (event.key === "Escape" && guide.conversationOpen) {
          event.preventDefault()
          event.stopPropagation()
          runCommandClose()
        } else if (
          !guide.conversationOpen &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey &&
          !event.shiftKey
        ) {
          const target = event.target instanceof Element ? event.target : null
          // Text editing retains arrows/Enter. Enter on a focused button retains its native action.
          if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
          if (event.key === "Enter" && target?.closest("button, a")) return
          if (event.key === "ArrowRight" || event.key === "Enter") {
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
      {guide.library && (
        <nav className="guide-sidebar" aria-label="Installed capabilities">
          <span className="guide-section-label">YOUR PLUGINS</span>
          <button data-flow="flows" onClick={() => runCommandLive("flows")}>
            <Library size={17} />
            Library
            <span className="guide-plugin-dot" />
          </button>
          {guide.librarian && (
            <>
              <button data-flow="wiki" onClick={() => runCommandLive("wiki")}>
                <BookOpen size={17} />
                Wiki
              </button>
              <button data-flow="history.show" onClick={() => runCommandLive("history.show")}>
                <History size={17} />
                Mythical history
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
      <main className="guide-main" inert={guide.conversationOpen ? true : undefined}>
        <div className="guide-chapter">
          <span className="guide-chapter-line" />
          {stage < 8
            ? "MEET SMITHERS"
            : stage < 11
              ? "BUILD YOUR WORKSPACE"
              : stage < 15
                ? "MAKE YOUR FIRST CHANGE"
                : "READY WHEN YOU ARE"}
          <span className="guide-chapter-line" />
        </div>
        <section key={stage} className="guide-lesson" aria-labelledby="guide-title">
          <div className="guide-sigil" aria-hidden="true">
            <Sparkles size={22} strokeWidth={1.2} />
          </div>
          <p className="guide-eyebrow">{eyebrow}</p>
          <h1 id="guide-title">{title}</h1>
          <div className="guide-dialogue smithers-control" data-controlled={stage < 7 || stage === 10}>
            <div className="guide-speaker">
              <span />
              SMITHERS
            </div>
            <p aria-live="polite" aria-atomic="true">
              <span className="guide-accessible-text">{body}</span>
              <span aria-hidden="true">{body.split(" ").map((word, index, words) => {
                const pauses = words.slice(0, index).filter(part => /[.!?]$/.test(part)).length
                return <span key={index} className="guide-word" style={{ "--word-delay": `${index * .065 + pauses * .35}s` } as CSSProperties}>{word}{" "}</span>
              })}</span>
            </p>
            {stage === 2 && (
              <button
                className="guide-text-button"
                data-flow="onboarding.act"
                onClick={() => runCommandGuide("notify")}
              >
                Send me a notification <Sparkles size={14} />
              </button>
            )}
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
                    ? "Saved on this device. Both answers are optional."
                    : saveStatus === "failed"
                      ? "Your answer could not be saved. Please try again."
                      : "Optional · your answers stay in this app on this device."}
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
                <small>Practice PR preview · nothing has been pushed or published.</small>
              </div>
            </div>
          )}
          {stage === 15 && (
            <div className="guide-start-actions">
              <button className="guide-primary" data-flow="connect" onClick={() => runCommandLive("connect")}>
                Choose a repository
                <ArrowRight size={16} />
              </button>
              <button
                className="guide-secondary"
                data-flow="feature.prototype"
                onClick={() => runCommandLive("feature.prototype")}
              >
                Start a real prototype
                <Sparkles size={16} />
              </button>
              <p>
                Sign in when requested. Real runs show their actual progress and any missing setup in the
                conversation.
              </p>
            </div>
          )}
          <div className="guide-actions">
            {stage === 3 ? (
              <button type="submit" form="guide-profile" className="guide-primary" data-flow="onboarding.act">
                Continue, with or without answers <ArrowRight size={16} />
              </button>
            ) : stage === 5 ? (
              primary("Run dark-mode flow", "dark", <Moon size={16} />)
            ) : stage === 6 ? (
              primary("Bring back the light", "light", <Sun size={16} />)
            ) : stage === 7 ? (
              <button
                ref={opener}
                className="guide-key-button"
                data-flow="onboarding.act"
                onClick={runCommandOpen}
              >
                <kbd>⌘</kbd>
                <kbd>K</kbd>
                <span>Call Smithers</span>
              </button>
            ) : stage === 8 ? (
              primary("Install Library", "library", <Library size={16} />)
            ) : stage === 9 ? (
              primary("Add Librarian", "librarian", <BookOpen size={16} />)
            ) : stage === 12 ? (
              primary("Keep this direction", "revise", <Check size={16} />)
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
                data-flow="onboarding.act"
                onClick={() => runCommandGuide("back")}
              >
                <ChevronLeft size={13} />
                Back
              </button>
            )}
          </div>
          <p className="guide-key-hint">
            <kbd>←</kbd> back <span>·</span> <kbd>→</kbd> or <kbd>enter</kbd>{" "}
            {stage === 5 || stage === 6
              ? "run flow"
              : stage === 8 || stage === 9
                ? "install"
                : stage === 7 || stage === 15
                  ? "call Smithers"
                  : "continue"}
          </p>
        </section>
      </main>
      <footer className="guide-footer">
        <button
          data-flow="onboarding.act"
          onClick={() => {
            runCommandGuide("sound")
            if (!guide.sound) chime()
          }}
          aria-label={guide.sound ? "Mute tutorial sounds" : "Enable tutorial sounds"}
        >
          {guide.sound ? <Volume2 size={15} /> : <VolumeX size={15} />}
          <span>Sound {guide.sound ? "on" : "off"}</span>
        </button>
        <div className="guide-progress" aria-label={`Lesson ${stage + 1} of 16`}>
          {Array.from({ length: 16 }, (_, i) => (
            <span key={i} data-passed={i <= stage} />
          ))}
        </div>
        {stage >= 7 && (
          <button ref={opener} data-flow="onboarding.act" onClick={runCommandOpen}>
            <Command size={14} />
            <span>K · Talk to Smithers</span>
          </button>
        )}
        {stage === 15 && (
          <button data-flow="onboarding.act" onClick={() => runCommandGuide("restart")}>
            Replay introduction
          </button>
        )}
      </footer>
      {guide.conversationOpen && (
        <div
          className="guide-conversation-backdrop"
          onClick={(event) => {
            if (event.target === event.currentTarget) runCommandClose()
          }}
        >
          <section
            className="guide-conversation smithers-control"
            data-controlled="true"
            role="dialog"
            aria-modal="true"
            aria-label="Talk to Smithers"
            ref={(node) => {
              if (node && !node.contains(document.activeElement))
                (
                  node.querySelector<HTMLTextAreaElement>("textarea") ??
                  node.querySelector<HTMLButtonElement>("button")
                )?.focus()
            }}
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
            <div className="guide-conversation-header">
              <span>
                <Sparkles size={15} />
                Smithers
              </span>
              <button data-flow="onboarding.act" aria-label="Close conversation" onClick={runCommandClose}>
                <span>esc</span>
                <X size={16} />
              </button>
            </div>
            {stage === 8 ? (
              <div className="guide-summoned">
                <p>There you are. This is where we’ll talk.</p>
                <p>
                  Press Escape when you want your space back. Now let’s give your workspace its first
                  capability.
                </p>
                <button className="guide-primary" data-flow="onboarding.act" onClick={runCommandClose}>
                  Meet the Library
                  <ArrowRight size={15} />
                </button>
              </div>
            ) : (
              children
            )}
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
              </button>
            </div>
          ))}
        </aside>
      )}
    </div>
  )
}
