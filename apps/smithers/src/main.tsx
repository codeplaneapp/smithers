import {
  StrictMode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { createRoot } from "react-dom/client";
import { CommandMenu, COMMANDS, type CommandId } from "./CommandMenu";
import { Markdown } from "./chat/Markdown";
import { streamReplyViaApi } from "./chat/streamReplyViaApi";
import {
  GRILL_EDGES,
  GRILL_NODES,
  GRILL_SYSTEM_PROMPT,
} from "./askme/grillMe";
import { WorkflowGraph } from "./askme/WorkflowGraph";
import { Toasts } from "./notifications/Toasts";
import { useNotifications } from "./notifications/useNotifications";
import { WorkflowStore } from "./store/WorkflowStore";
import type { StoreWorkflow } from "./store/workflows";
import "./styles.css";

const PROJECTS = ["Smithers Web", "Personal", "Sandbox", "Marketing Site"] as const;

const API_KEY_STORAGE = "smithers.cerebras.apiKey";

const KEY_HELP =
  "Add a Cerebras API key to chat. Set VITE_CEREBRAS_API_KEY at build time, or reload and paste a key when prompted.";

/** Dev-only preview: the rotating text of an always-running mock toast. */
const MOCK_TOAST_STEPS = [
  "Planning the run…",
  "Spawning 3 agents…",
  "Reading the codebase…",
  "Drafting the spec…",
  "Reviewing findings…",
  "Synthesizing results…",
];

/**
 * The chat talks to Cerebras straight from the browser, so it needs the user's
 * own API key. Prefer a stored/env key; otherwise prompt once and remember it.
 * The key never leaves this browser except in requests to api.cerebras.ai.
 */
function ensureCerebrasKey(): string {
  let key =
    window.localStorage.getItem(API_KEY_STORAGE) ??
    import.meta.env.VITE_CEREBRAS_API_KEY ??
    "";
  if (!key) {
    const entered = window
      .prompt("Enter your Cerebras API key (stored locally in this browser):")
      ?.trim();
    if (entered) {
      window.localStorage.setItem(API_KEY_STORAGE, entered);
      key = entered;
    }
  }
  return key;
}

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((event: SpeechRecognitionResultEvent) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
};

type SpeechRecognitionResultEvent = {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
};

function getSpeechRecognition(): SpeechRecognitionLike | null {
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  const Recognition = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  return Recognition ? new Recognition() : null;
}

function Composer() {
  const [query, setQuery] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pending, setPending] = useState(false);
  const [project, setProject] = useState<string>(PROJECTS[0]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [listening, setListening] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const stored = window.localStorage.getItem("smithers.theme");
    if (stored === "light" || stored === "dark") {
      return stored;
    }
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  });

  // Apply the theme to <html> (CSS reads [data-theme]) and remember the choice.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem("smithers.theme", theme);
    } catch {
      // Storage disabled (private mode); the theme still applies this session.
    }
  }, [theme]);
  const [navDir, setNavDir] = useState<"back" | "forward">("forward");
  // Command navigation: the back/forward arrows step through COMMANDS; the
  // pill jumps straight to one. `commandIndex` is the active view.
  const [commandIndex, setCommandIndex] = useState(0);
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const projectRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const idRef = useRef(0);
  const conversationRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLFormElement>(null);
  const prevRectRef = useRef<DOMRect | null>(null);
  const { notifications, notify, update, dismiss } = useNotifications();

  const command = COMMANDS[commandIndex].id;
  const showGraph = command === "askme";
  const showStore = command === "store";
  // Ask Me (graph) and Store both dock the composer immediately.
  const isChat = messages.length > 0 || showGraph || showStore;

  const goToIndex = useCallback(
    (index: number) => {
      const clamped = Math.max(0, Math.min(COMMANDS.length - 1, index));
      setNavDir(clamped > commandIndex ? "forward" : "back");
      setCommandIndex(clamped);
    },
    [commandIndex],
  );

  const goToCommand = useCallback(
    (id: CommandId) => {
      const index = COMMANDS.findIndex((entry) => entry.id === id);
      if (index >= 0) {
        goToIndex(index);
      }
    },
    [goToIndex],
  );

  // Open a workflow picked from the store: jump to its view, or drop into chat
  // with a starter prompt prefilled.
  const openWorkflow = useCallback(
    (workflow: StoreWorkflow) => {
      if (workflow.command) {
        goToCommand(workflow.command);
      } else if (workflow.starter) {
        goToCommand("chat");
        setQuery(workflow.starter);
        requestAnimationFrame(() => inputRef.current?.focus());
      }
      notify({
        title: workflow.name,
        detail: "Workflow opened",
        kind: "transient",
        command: workflow.command,
      });
    },
    [goToCommand, notify],
  );

  const nextId = () => {
    idRef.current += 1;
    return String(idRef.current);
  };

  useEffect(() => {
    const el = conversationRef.current;
    if (el) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
  }, [messages, pending]);

  // Focus the input on first paint and again after the home → chat transition,
  // so it stays ready to type.
  useEffect(() => {
    inputRef.current?.focus();
  }, [isChat]);

  // Dev-only preview: a never-ending workflow toast whose text keeps updating,
  // so the toast UI stays visible while iterating on it.
  useEffect(() => {
    if (!import.meta.env.DEV) {
      return;
    }
    const id = notify({
      title: "Demo workflow",
      detail: MOCK_TOAST_STEPS[0],
      kind: "workflow",
      command: "askme",
    });
    let step = 0;
    const interval = window.setInterval(() => {
      step = (step + 1) % MOCK_TOAST_STEPS.length;
      update(id, { detail: MOCK_TOAST_STEPS[step] });
    }, 1700);
    return () => {
      window.clearInterval(interval);
      dismiss(id);
    };
  }, [notify, update, dismiss]);

  // FLIP: glide the composer from its centered hero position down to the docked
  // position instead of letting it jump when the layout switches.
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) {
      return;
    }
    const next = card.getBoundingClientRect();
    const prev = prevRectRef.current;
    prevRectRef.current = next;
    if (!prev) {
      return;
    }
    const dx = prev.left - next.left;
    const dy = prev.top - next.top;
    if (dx === 0 && dy === 0) {
      return;
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    card.style.transition = "none";
    card.style.transform = `translate(${dx}px, ${dy}px)`;
    requestAnimationFrame(() => {
      card.style.transition = "transform 220ms cubic-bezier(0.22, 1, 0.36, 1)";
      card.style.transform = "";
      const clear = () => {
        card.style.transition = "";
        card.removeEventListener("transitionend", clear);
      };
      card.addEventListener("transitionend", clear);
    });
  });

  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!projectRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const raw = query.trim();
      if (!raw || pending) {
        return;
      }

      // Asking to open the store, in plain language, opens it.
      if (/^(open |show |go to )?(the )?store$/i.test(raw)) {
        setQuery("");
        goToCommand("store");
        return;
      }

      // A leading "/askme", "/chat", or "/store" switches the active view; the
      // rest of the line (if any) is sent as the message.
      let text = raw;
      let active = command;
      const slash = raw.match(/^\/(askme|chat|store)\b\s*([\s\S]*)$/i);
      if (slash) {
        active = slash[1].toLowerCase() as CommandId;
        text = slash[2].trim();
        if (active !== command) {
          goToCommand(active);
        }
      }

      setQuery("");
      // The store is a browse view, not a chat target — opening it is enough.
      if (active === "store") {
        return;
      }
      if (!text) {
        // Bare "/askme" — switch the view, nothing to send yet.
        return;
      }

      setMessages((prev) => [...prev, { id: nextId(), role: "user", text }]);
      setPending(true);

      // Ask Me runs the grill-me interview; plain chat has no system prompt.
      const system = active === "askme" ? GRILL_SYSTEM_PROMPT : undefined;

      // Surface the workflow run as a corner toast that stays until it finishes.
      const notifId =
        active === "askme"
          ? notify({
              title: "Ask Me",
              detail: text.length > 48 ? `${text.slice(0, 48)}…` : text,
              kind: "workflow",
              command: "askme",
            })
          : null;

      // Conversation so far plus the turn we just sent. `messages` doesn't
      // include it yet (state updates are async), so append it explicitly and
      // map to Cerebras' { role, content } wire shape.
      const wireHistory = [
        ...messages.map((message) => ({
          role: message.role,
          content: message.text,
        })),
        { role: "user" as const, content: text },
      ];

      // Stream the reply from the Cerebras-backed Worker (POST /api/chat),
      // appending deltas to a single assistant bubble.
      const assistantId = nextId();
      let acc = "";
      let started = false;
      try {
        for await (const delta of streamReplyViaApi({
          messages: wireHistory,
          system,
        })) {
          acc += delta;
          if (!started) {
            started = true;
            setPending(false);
            setMessages((prev) => [
              ...prev,
              { id: assistantId, role: "assistant", text: acc },
            ]);
          } else {
            setMessages((prev) =>
              prev.map((message) =>
                message.id === assistantId
                  ? { ...message, text: acc }
                  : message,
              ),
            );
          }
        }
        if (!started) {
          setMessages((prev) => [
            ...prev,
            { id: assistantId, role: "assistant", text: "(no response)" },
          ]);
        }
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Something went wrong talking to Cerebras.";
        setMessages((prev) =>
          started
            ? prev.map((entry) =>
                entry.id === assistantId
                  ? { ...entry, text: `${acc}\n\n⚠️ ${message}` }
                  : entry,
              )
            : [
                ...prev,
                { id: assistantId, role: "assistant", text: `⚠️ ${message}` },
              ],
        );
      } finally {
        setPending(false);
        if (notifId) {
          update(notifId, { status: "done" });
        }
      }
    },
    [query, pending, messages, command, goToCommand, notify, update],
  );

  const toggleDictation = useCallback(() => {
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    const recognition = getSpeechRecognition();
    if (!recognition) {
      return;
    }
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.continuous = false;
    recognition.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript ?? "";
      if (transcript) {
        setQuery((current) =>
          current ? `${current} ${transcript}` : transcript,
        );
      }
    };
    recognition.onerror = () => setListening(false);
    recognition.onend = () => setListening(false);
    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
  }, [listening]);

  const composer = (
    <form className="composer-card" onSubmit={handleSubmit} ref={cardRef}>
      <div className="composer-top-row">
        <div className="composer-input">
          <input
            aria-label="Message Smithers"
            autoComplete="off"
            id={inputId}
            placeholder="Ask Smithers to build…"
            ref={inputRef}
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        <nav className="top-controls" aria-label="View navigation">
          <button
            aria-label={
              theme === "dark" ? "Switch to light mode" : "Switch to dark mode"
            }
            className="nav-button"
            type="button"
            onClick={() =>
              setTheme((value) => (value === "dark" ? "light" : "dark"))
            }
          >
            {theme === "dark" ? (
              <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
                <circle
                  cx="12"
                  cy="12"
                  r="4"
                  stroke="currentColor"
                  strokeWidth="2"
                />
                <path
                  d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4M17.6 17.6 19 19M5 19l1.4-1.4M17.6 6.4 19 5"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeWidth="2"
                />
              </svg>
            ) : (
              <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
                <path
                  d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                />
              </svg>
            )}
          </button>
          <CommandMenu active={command} onSelect={goToCommand} />
        </nav>
      </div>

      <div className="composer-toolbar">
        <div className="project-control" ref={projectRef}>
          <button
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            className="ghost-pill"
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span>{project}</span>
            <svg
              aria-hidden="true"
              className="chevron"
              fill="none"
              viewBox="0 0 24 24"
            >
              <path
                d="m6 9 6 6 6-6"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
              />
            </svg>
          </button>

          {menuOpen ? (
            <div className="project-menu" role="menu">
              {PROJECTS.map((name) => (
                <button
                  aria-checked={name === project}
                  className="project-option"
                  key={name}
                  role="menuitemradio"
                  type="button"
                  onClick={() => {
                    setProject(name);
                    setMenuOpen(false);
                  }}
                >
                  <span>{name}</span>
                  {name === project ? (
                    <svg
                      aria-hidden="true"
                      className="check"
                      fill="none"
                      viewBox="0 0 24 24"
                    >
                      <path
                        d="m5 13 4 4L19 7"
                        stroke="currentColor"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                      />
                    </svg>
                  ) : null}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <button
          aria-label={listening ? "Stop dictation" : "Start dictation"}
          aria-pressed={listening}
          className={listening ? "mic-button is-listening" : "mic-button"}
          type="button"
          onClick={toggleDictation}
        >
          <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
            <path
              d="M12 4a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V7a3 3 0 0 0-3-3Z"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
            />
            <path
              d="M5 11a7 7 0 0 0 14 0M12 18v3"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
            />
          </svg>
        </button>
      </div>
    </form>
  );

  return (
    <main
      className="app-shell"
      data-command={command}
      data-mode={isChat ? "chat" : "home"}
    >
      <Toasts
        notifications={notifications}
        onDismiss={dismiss}
        onView={(notification) => goToCommand(notification.command ?? "askme")}
      />

      <div className="view" data-dir={navDir} key={commandIndex}>
        {showStore ? (
          <WorkflowStore onOpen={openWorkflow} />
        ) : isChat ? (
          <>
            {showGraph ? (
              <div className="askme-graph">
                <WorkflowGraph
                  nodes={GRILL_NODES}
                  edges={GRILL_EDGES}
                  theme={theme}
                />
              </div>
            ) : null}
            <div
              className="conversation"
              ref={conversationRef}
              role="log"
              aria-live="polite"
            >
              <div className="messages">
                {messages.length === 0 && showGraph ? (
                  <p className="askme-hint">
                    Tell me what to grill you on — type a topic and hit Enter.
                  </p>
                ) : null}
                {messages.map((message) => (
                  <div className={`message ${message.role}`} key={message.id}>
                    <div className="bubble">
                      {message.role === "assistant" ? (
                        <Markdown content={message.text} />
                      ) : (
                        message.text
                      )}
                    </div>
                  </div>
                ))}
                {pending ? (
                  <div className="message assistant">
                    <div
                      className="bubble typing"
                      aria-label="Smithers is thinking"
                    >
                      <span />
                      <span />
                      <span />
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </>
        ) : (
          <h1 className="composer-title">How can I help you?</h1>
        )}
      </div>

      <div className="composer-dock">{composer}</div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Composer />
  </StrictMode>,
);

if ("serviceWorker" in navigator) {
  if (import.meta.env.PROD) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch((error: unknown) => {
        console.error("Service worker registration failed", error);
      });
    });
  } else {
    // Dev: a cache-first service worker would serve stale assets over Vite's
    // HMR. Tear down any existing registration and caches so the dev server is
    // always the source of truth.
    navigator.serviceWorker.getRegistrations().then((registrations) => {
      for (const registration of registrations) {
        registration.unregister();
      }
    });
    if ("caches" in window) {
      caches.keys().then((keys) => {
        for (const key of keys) {
          caches.delete(key);
        }
      });
    }
  }
}
