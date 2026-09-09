import { expect, test } from "bun:test"
import { GUIDE_LESSONS } from "../onboarding/lessons"
import { createAppStore } from "./AppStore"
import { initialGuide, initialSession } from "./AppState"
import type { Session } from "./AppState"

/*
 * The 16-lesson build (guide version 1) numbered the light lesson alone at
 * step 2; the 15-lesson build (version 2) folds it into the theme lesson, so
 * every later lesson moved one down. A persisted version-1 guide has to be
 * remapped at boot — otherwise a returning user lands one lesson ahead of
 * where they were, and the lesson they SEE (its key gesture, its button)
 * belongs to a step they are no longer on.
 */

const storageOf = (data: Map<string, string>) => ({
  getItem: (key: string) => data.get(key) ?? null,
  setItem: (key: string, value: string) => { data.set(key, value) },
  removeItem: (key: string) => { data.delete(key) },
})

/** A persisted session row as the durable layer stores it, carrying a version-1 guide. */
const seedLegacySession = (data: Map<string, string>, step: number, over: Partial<Session> = {}) => {
  const guide = { ...initialGuide(), version: 1 as const, step }
  const session: Session = { ...initialSession("light"), ...over, guide }
  data.set("smithers-mvp.app-sessions", JSON.stringify({
    "s:main": { versionKey: "legacy", data: session },
  }))
}

const boot = async (data: Map<string, string>) =>
  createAppStore({ kind: "localStorage", storage: storageOf(data) })

test("a version-1 guide on the old notification lesson lands on the new one", async () => {
  const notificationStep = GUIDE_LESSONS.findIndex((lesson) => lesson.includes("notifications from time to time"))
  expect(notificationStep).toBeGreaterThanOrEqual(2)
  const data = new Map<string, string>()
  // The 16-lesson build showed the notification lesson one step later.
  seedLegacySession(data, notificationStep + 1)
  const store = await boot(data)
  const guide = store.session().guide
  expect(guide?.version).toBe(2)
  expect(guide?.step).toBe(notificationStep)
  expect(GUIDE_LESSONS[guide?.step ?? -1]).toContain("notifications from time to time")
  await store.dispose?.()
})

test("a finished version-1 tutorial stays finished, and the session around it survives", async () => {
  const data = new Map<string, string>()
  // Step 15 was the 16-lesson build's last step — beyond version 2's scale.
  seedLegacySession(data, 15, { draft: "half-written thought" })
  const store = await boot(data)
  const session = store.session()
  expect(session.guide?.version).toBe(2)
  expect(session.guide?.step).toBe(14)
  expect(session.draft).toBe("half-written thought")
  await store.dispose?.()
})

test("a version-1 guide before the folded lesson keeps its step", async () => {
  const data = new Map<string, string>()
  seedLegacySession(data, 1)
  const store = await boot(data)
  expect(store.session().guide?.step).toBe(1)
  expect(store.session().guide?.version).toBe(2)
  await store.dispose?.()
})

test("a version-2 guide is never remapped, including across a reload", async () => {
  const data = new Map<string, string>()
  const first = await boot(data)
  await first.dispatch({ type: "guide.changed", actor: "user", guide: { ...initialGuide(), step: 5 } }).isPersisted.promise
  await first.dispose?.()
  const second = await boot(data)
  const guide = second.session().guide
  expect(guide?.version).toBe(2)
  expect(guide?.step).toBe(5)
  await second.dispose?.()
})
