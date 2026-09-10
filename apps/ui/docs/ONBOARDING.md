# Onboarding design

**Owner:** Will · **Direction:** September 8, 2026 · **Status:** v0 implementation for hands-on iteration

This brief replaces the always-visible-chat and fixed sidebar model. Smithers opens as a quiet workspace. The UI itself is the default view: full-screen, with no composer. Command K / Control K summons ONLY the composer — a solid bottom dock that animates open and pushes the content up, dismissed with Escape or a second Command K. The conversation lives in the full-screen UI underneath, never inside the dock. The homepage is separate work.

## The feeling

A small, beautifully paced beginning that teaches by doing. Final Fantasy IX is the reference for patient teaching, warmth, atmosphere, and a companion who explains what is happening. Borrow its care, not its imagery, music, or interface assets. No overwhelming feature wall, compulsory questionnaire, or unexplained background jobs.

Paper, muted water green, gold light, fine borders, serif chapter titles, and the existing Inter / IBM Plex Mono typography. Dark mode becomes a deep blue-green night. Sound is off initially; an explicit toggle enables a short original, gentle musical interval on lesson actions. Reduced-motion users get every lesson with immediate transitions.

## Entrance and control

The README's block-letter SMITHERS resolves from light into its full wordmark, holds briefly, and settles in the top-right corner in approximately one second. Remove WORKSPACE. Only then does Smithers' dialogue arrive. First landing exposes no sidebar capabilities.

The reusable `smithers-control` glow means Smithers controls a surface: a faint water-green and gold edge with soft breathing light. It must not mean an operation succeeded or a background flow is running. Pair it with explicit text describing the act. Never manufacture progress from a timer.

## The playable sequence

1. **Hello. I'm Smithers.** A calm personal introduction; one clear forward action.
2. **Control the UI.** “I am more than a chat app. I control this entire UI. And I will help you get work done. For example, let’s change the theme: dark mode, and back to light.” Enter or Change theme flips the theme, holds so the change is seen, and returns to the starting theme — one lesson, both modes. The glow explains itself visually.
3. **Notifications.** Send a deliberate notification using the button or N.
4. **UI widgets.** After the message’s final word finishes revealing, an optional form appears and scrolls into view. It asks how the user found Smithers and what they want to build; answers are saved when continuing. Reduced motion reveals the form immediately.
5. **Flows.** Explain executable instructions and offer the five-second example with R.
6. **New flows.** Smithers can create useful flows for the user.
7. **Talk directly.** The lesson says “You can talk directly to me. Try it now.” and shows the gesture as a numbered step (the reusable `GuideSteps` component): “1. Press ⌘ K (or Ctrl K) and type a message to me.” Command K / Control K summons the composer (a touch/click fallback is available). The composer slides in from the bottom and resizes the lesson above; demonstrate Escape and restore focus. While the tutorial runs, every chat turn carries the lesson transcript in the agent runtime context (the onboarding block): a conversational message gets one short answer that hands the lesson back, and a real task or a request to skip ends the tutorial through `onboarding.act finish` and is answered in the same turn.
8. **Open the Library.** The lesson names the real command: “Type /plugins in the composer and I’ll open it.” Enter, the “Open the Library” button, and the typed slash all run the same `plugins` flow — the Library pane opens and the lesson is finished by that real act, not a tutorial-only button. The sidebar's plugin rail lists only what is actually installed.
9. **Install the Librarian.** The lesson's gallery is the real Library shelf. “Install the Librarian” (or typing `/plugins.install librarian`) runs the real `plugins.install` flow; the rail then shows what the Librarian adds (Wiki, Mythical history).
10. **Two background flows.** Describe what each proposed run does, why it exists, and how to inspect progress. In live mode, ask for the repository and approval before launching. Background work must use existing flow execution, run identifiers, and receipts.
11. **Fast POC.** Show something tangible first: a small idea board. This is disposable code; preserve the artifact and feedback.
12. **Make it yours.** Edit the board heading directly, see the result immediately, accept the direction. This is an action, not another slide.
13. **Mythical Change.** Show feedback becoming an implementation plan. Stable foundations come first; logical Changes group atomic JJ changes; receipts attach to exact revisions. Amend the owning change and restack descendants. Never present prototype code as the final implementation.
14. **First PR.** Explain implementation → review/checks → user acceptance (“vibed”) → cleanup/append-only main → optional delivery. Show the reviewable PR before any publication. The production sequence must produce a real link only after the backend reports it.
15. **Your workspace.** Conversation is closed. Choose a repository or start a real prototype through the existing registered flows. Keep replay available.

## v0 truth boundary

The entrance, lesson progression, optional answers, local plugin activation, theme changes, notification, Command-K conversation, editable POC, and feedback are real local app behavior persisted in the existing TanStack DB / SQLite session collection. The conversation uses the actual app controller and existing cards.

Library and Librarian currently activate the v0 shell's built-in capabilities locally. They do not download plugin packages or register background workflows. The codebase learning, mythical-history diagram, and PR preview are explicitly a rehearsal, not reported backend work. No run table, repository, JJ history, or GitHub PR is fabricated. The existing `feature.prototype` operation can refuse when the selected workspace lacks its prototype flow; that refusal remains visible.

Remaining live integration: a repository plugin installation contract, real Librarian wiki/history launch and progress, actual POC generation and implementation receipts, and first-PR delivery. Use the repository's existing flow engine and stores; do not introduce a parallel job service or coding ledger. Completing the visual rehearsal does not mean those integrations exist.

## Interaction and implementation contract

- Versioned lesson state survives reload in the existing session row. No localStorage authority, separate database, or React effect-driven orchestration.
- Buttons, slash invocations, and agent actions enter the same registered flow and actor-tagged transition dispatcher. Theme changes use the shared theme transition; conversation uses the existing controller.
- Optional answers stay local in v0. Do not automatically transmit them as analytics or agent memory.
- The guide never auto-publishes or starts paid/background work because a lesson completed.
- Keyboard: visible focus, tab containment in the conversation, Escape dismissal, focus restoration, Command K and Control K. Respect reduced motion. Layout works at narrow widths without hiding required actions.
- Preserve existing repository data and sessions. Replay resets only the guide. Existing commands remain available through the conversation; the sidebar is progressively revealed.

## What to judge in the first playtest

Does the first second feel intentional? Is the glow understandable? Does the user recognize every real action? Is the optional form truly optional? Can they summon and dismiss Smithers without thinking? Does the Library installation feel like acquiring a capability? Can they distinguish the practice project from their repository? Do they understand that prototype feedback—not prototype code—goes into the implementation? Where does the pace drag, and where do they want to act instead of read?

## Keyboard-first refinement (Will, September 8)

Enter and Right Arrow perform the current lesson's primary action, including the theme demonstration and plugin activation. Left Arrow returns to the preceding lesson. A focused button keeps its own native Enter action; text fields retain arrow editing. Enter submits the optional widget without requiring an answer, and accepts the prototype heading. Command K / Control K summons the conversation, Escape closes it, and Tab traverses every interactive control. Repeated held navigation keys do not skip lessons. Every lesson displays shortcuts inline inside its buttons: Enter for the primary action, Left Arrow for Back, and Escape for closing the conversation. Secondary actions show Tab ↵: Tab to the button, then Enter. Mouse use is never required.

Keyboard-only operation is a rule for the whole product. Required interactions must never depend on hovering, dragging, or pointer coordinates. All new workflows must have a tested keyboard completion path, including visible focus, native activation, text editing, and modal focus restoration.

## Opening pace refinement

The wordmark settles in about one second, then the meeting moves quickly: the introduction card arrives at 1.2s, its words reveal from 1.5s at 15ms per word with 60ms pauses between sentences, and the invitation is up by ~2.4s. Subsequent lessons reveal word by word on the same cadence while the message card opens. Reduced motion is immediate. Enter/Right can advance immediately for a returning or fast reader.

## Practice review

The PR lesson shows the original and proposed headings, offers a return to editing, and requires an explicit “Accept practice change” action. Enter/Right invoke that same action. Acceptance records the exact practice heading in the existing session row; editing or replaying clears it. The final workspace acknowledges the accepted direction. This is a local review rehearsal, not a GitHub approval or publication.

## Replay and fresh-user testing

Onboarding runs automatically when this app has no saved guide progress. At any step, press Command K / Control K and type `/tut` to replay from the opening animation. The conversation input remains available during the Library introduction too.

Use `/debug.reset` for a fresh-user test: sign out of active app sessions, clear all local app collections (including messages, optional answers, plugin activation, frames, workspace selections, cards and guide progress), restore the initial appearance, and reload into onboarding. The reset waits for persistence, fences late writes from the old session, and closes its subscriptions before reloading. Repository files and remote work are not deleted. Agent-triggered resets require confirmation; typing the command yourself performs the requested reset.

The opening message is “Hello. I’m Smithers. Let me show how Smithers works”. Every lesson uses the same minimal structure: one Smithers message, its interactive example when needed, and buttons with inline key hints. No separate greeting headings, eyebrows, decorative top icons, or chapter labels. Message text appears once in the DOM, with the same accessible text animating visually.

Tutorial lessons append Smithers messages to a continuous, scrollable chat history. Earlier messages remain mounted; only the newest message animates. The persisted lesson position reconstructs the history on reload; Back rewinds and `/tut` starts over. Interactive examples and the current actions sit below the transcript. A new message OPENS its place — its grid track grows over 450ms so the history above shifts up while the actions below move down as one stable row; the row never re-animates and never trades places with a retiring copy, and its buttons are keyed per step so the activated control never morphs mid-gesture. The transcript scrolls smoothly to the newest message. Reduced motion switches immediately; browsers without animatable grid tracks show the message in place.

The workspace step hands the window to the app: the tutorial chrome (transcript, header, wordmark, plugin shelf, progress) retires, and the app stands full-screen without a composer. The outro card (the accepted direction and the two start actions) appears only while the current conversation has no persisted messages or cards. A real message, form, or run retires those start actions immediately; reload and tutorial replay preserve the unobscured conversation. This is a projection of the existing collections, not another completion flag. The footer remains. Command K summons the composer below the workspace and above the footer — the dock grows between the two, so it never opens beneath the footer chrome; a sent message and its reply land in the full-screen conversation underneath. Toasts keep reporting through the guide's stack while the guide is mounted.

The notification lesson waits for the user: “Send me a notification” displays an inline N shortcut. Clicking it or pressing N sends the same sample notification without advancing the lesson. Text fields retain ordinary typing.

## Cloud answers and the first real flow

Optional profile drafts stay local while typing; Continue submits nonempty answers to `https://bug.smithers.sh/api/onboarding-answers`. The form says they are shared with the Smithers team. Cloudflare KV (`BUGS`, `onboarding:` prefix) stores answers and receipt time for operator review; a stable UUID makes retries replace the same record. Failed saves keep the form open. Empty forms still advance. See `apps/bug-worker/ONBOARDING.md` for private review/export. Local reset does not erase submitted answers.

The flows lesson has “Run a flow · R”: a real five-second asynchronous wait through `onboarding.act wait-flow`. It creates one toast: “Waiting 5 seconds…” with a spinner, then “Done” with a checkmark. No status text appears beneath the button. Toasts remain visible when the composer is open. Repeat invocation while running does nothing. Navigation is preserved, and a reload marks an unfinished example interrupted so it can be retried.

Command K displays only the composer, including in the Library lesson. There is no greeting, transcript, or “Meet the Library” panel inside the dock. Tutorial and real chat history remain in the main view.

The summoned UI is the composer input itself, without an outer card, repository header, origin label, + menu, or Chat/Connect/Wiki/Flows toolbar. Repository selection lives in the left workspace sidebar, including before plugin installation. The picker retains keyboard menu navigation and Escape restores focus.

Sound toggles directly with **S**, shown inline on its button; character shortcuts never interrupt text entry. Prefer direct shortcuts over instructing users to Tab to controls. **Escape** dismisses the summoned composer even after focus leaves the input, preserving the draft and restoring workspace focus.
