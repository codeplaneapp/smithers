/*
 * The guided introduction's lesson copy, in lesson order. One module owns it
 * so the two readers never drift: GuideShell renders it as the tutorial
 * transcript, and the turn controller quotes it to the chat model (the
 * onboarding block of the agent runtime context) so a message sent mid-
 * tutorial is answered against what the user has actually seen.
 */
export const GUIDE_LESSONS = [
  "Hello. I’m Smithers. Let me show how Smithers works",
  "I am more than a chat app. I control this entire UI. And I will help you get work done. For example, let’s change the theme: dark mode, and back to light.",
  "I can send you notifications from time to time, like this. You don’t need to watch every flow to know what’s happening.",
  "I can talk to you with UI widgets, too. Here’s a small form so I can get to know you. Everything here is optional.",
  "But the coolest thing I can do is run flows. Flows are instructions that can be executed to get work done. Everything in this app is modeled as a flow.",
  "From time to time, I’ll create new flows that I think will be useful for you.",
  "You can talk directly to me. Try it now.",
  "Plugins give this workspace its abilities. The Library is where you find them. Type /plugins in the composer and I’ll open it.",
  "The Librarian learns a codebase and makes it easier for both of us to understand. Install it from the Library — it is the first plugin I recommend — and I’ll walk you through its first two background flows.",
  "On your codebase, the Librarian will ask to build a wiki and a mythical history in the background. You can inspect either run while you work. Let’s rehearse that in a small practice project.",
  "Before committing to an implementation, we try the idea. Here’s our little idea board. This prototype is disposable; what we learn is what we keep.",
  "Change the heading below. You’ll see the prototype update immediately. When it feels right, we’ll carry your feedback into the real plan.",
  "We keep your feedback, discard the prototype code, and plan the implementation with hindsight. A logical Change groups the atomic changes. Mythical history puts stable foundations first.",
  "Implementation, review, and checks come first. When you say it feels right, cleanup turns the accepted work into append-only main history. Delivery can then open a real PR.",
  "You’ve met flows, plugins, and the path from a quick idea to a reviewed change. I’ll sometimes suggest new flows that could help. You decide what to add.",
] as const

/** Lessons are 0-based steps in the guide state; the workspace step (last) ends the tutorial. */
export const GUIDE_LAST_STEP = GUIDE_LESSONS.length - 1
