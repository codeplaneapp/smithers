# Onboarding design

**Owner:** Will · **Direction:** September 8, 2026 · **Status:** v0 implementation for hands-on iteration

This brief replaces the always-visible-chat and fixed sidebar model. Smithers opens as a quiet workspace. The conversation lives in a translucent panel at the top of the window, summoned with Command K / Control K and dismissed with Escape. The homepage is separate work.

## The feeling

A small, beautifully paced beginning that teaches by doing. Final Fantasy IX is the reference for patient teaching, warmth, atmosphere, and a companion who explains what is happening. Borrow its care, not its imagery, music, or interface assets. No overwhelming feature wall, compulsory questionnaire, or unexplained background jobs.

Paper, muted water green, gold light, fine borders, serif chapter titles, and the existing Inter / IBM Plex Mono typography. Dark mode becomes a deep blue-green night. Sound is off initially; an explicit toggle enables a short original, gentle musical interval on lesson actions. Reduced-motion users get every lesson with immediate transitions.

## Entrance and control

The README's block-letter SMITHERS resolves from light into its full wordmark, holds briefly, and settles in the top-right corner in approximately one second. Remove WORKSPACE. Only then does Smithers' dialogue arrive. First landing exposes no sidebar capabilities.

The reusable `smithers-control` glow means Smithers controls a surface: a faint water-green and gold edge with soft breathing light. It must not mean an operation succeeded or a background flow is running. Pair it with explicit text describing the act. Never manufacture progress from a timer.

## The playable sequence

1. **Hello. I'm Smithers.** A calm personal introduction; one clear forward action.
2. **Conversation.** “I can speak to you normally like this, in a normal chat message.” Explain the glow while the dialogue is glowing.
3. **Notifications.** Explain the gentle tap on the shoulder and send a deliberate tutorial notification into the real app notification collection. Allow replay and dismissal.
4. **UI widgets.** An optional form asks how the user found Smithers and what they would like to build. Both answers may be empty; Continue works without submission. State where answers are saved.
5. **Flows.** Explain executable instructions as the common model for everything in the app.
6. **Dark mode.** Run a real local theme transition and let the workspace change around the user.
7. **Light mode.** Run the reverse transition. Nothing advances on a reading timer.
8. **Call me when you need me.** Hide the conversation; the user performs Command K / Control K (a touch/click fallback is available). Open the translucent top conversation, demonstrate Escape, and restore focus.
9. **Install Library.** Explain plugins as the way capabilities are added. The user's explicit action adds the Library to the empty sidebar.
10. **Add Librarian.** Explain its wiki and mythical-history capabilities before revealing them.
11. **Two background flows.** Describe what each proposed run does, why it exists, and how to inspect progress. In live mode, ask for the repository and approval before launching. Background work must use existing flow execution, run identifiers, and receipts.
12. **Fast POC.** Show something tangible first: a small idea board. This is disposable code; preserve the artifact and feedback.
13. **Make it yours.** Edit the board heading directly, see the result immediately, accept the direction. This is an action, not another slide.
14. **Mythical Change.** Show feedback becoming an implementation plan. Stable foundations come first; logical Changes group atomic JJ changes; receipts attach to exact revisions. Amend the owning change and restack descendants. Never present prototype code as the final implementation.
15. **First PR.** Explain implementation → review/checks → user acceptance (“vibed”) → cleanup/append-only main → optional delivery. Show the reviewable PR before any publication. The production sequence must produce a real link only after the backend reports it.
16. **Your workspace.** Conversation is closed. Choose a repository or start a real prototype through the existing registered flows. Keep replay available.

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

Enter and Right Arrow perform the current lesson's primary action, including theme demonstrations and plugin activation. Left Arrow returns to the preceding lesson. A focused button keeps its own native Enter action; text fields retain arrow editing. Enter submits the optional widget without requiring an answer, and accepts the prototype heading. Command K / Control K summons the conversation, Escape closes it, and Tab traverses every interactive control. Repeated held navigation keys do not skip lessons. The lesson itself displays the shortcuts; mouse use is never required.

Keyboard-only operation is a rule for the whole product. Required interactions must never depend on hovering, dragging, or pointer coordinates. All new workflows must have a tested keyboard completion path, including visible focus, native activation, text editing, and modal focus restoration.

## Opening pace refinement

The wordmark still settles in about one second. The rest is deliberately slower: sigil at 1.15s, greeting at 1.9s, dialogue at 2.65s, words from 3.05s with pauses between sentences, and the invitation at 5.4s. Subsequent lesson messages reveal word by word. Layout reserves the full message space; assistive technology receives one complete message, not a stream of word announcements. Reduced motion is immediate. Enter/Right can advance immediately for a returning or fast reader.

## Practice review

The PR lesson shows the original and proposed headings, offers a return to editing, and requires an explicit “Accept practice change” action. Enter/Right invoke that same action. Acceptance records the exact practice heading in the existing session row; editing or replaying clears it. The final workspace acknowledges the accepted direction. This is a local review rehearsal, not a GitHub approval or publication.
