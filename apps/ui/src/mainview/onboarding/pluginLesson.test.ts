import { expect, test } from "bun:test"
import { initialGuide } from "../state/AppState"
import { GUIDE_LESSONS } from "./lessons"
import { LESSON_PLUGIN, LIBRARIAN_LESSON_STEP, libraryOpened, PLUGINS_LESSON_STEP, pluginInstalled } from "./pluginLesson"

const at = (step: number, over: Partial<ReturnType<typeof initialGuide>> = {}) => ({ ...initialGuide(), step, ...over })

test("both plugin lessons are still in the copy, and still adjacent", () => {
  expect(PLUGINS_LESSON_STEP).toBeGreaterThanOrEqual(0)
  expect(LIBRARIAN_LESSON_STEP).toBe(PLUGINS_LESSON_STEP + 1)
  expect(GUIDE_LESSONS[PLUGINS_LESSON_STEP]).toContain("/plugins")
})

test("opening the Library finishes its lesson and tucks the conversation away", () => {
  const advanced = libraryOpened(at(PLUGINS_LESSON_STEP, { conversationOpen: true }))
  expect(advanced?.library).toBe(true)
  expect(advanced?.step).toBe(LIBRARIAN_LESSON_STEP)
  expect(advanced?.conversationOpen).toBe(false)
})

test("opening the Library anywhere else is just a flow", () => {
  expect(libraryOpened(at(0))).toBeUndefined()
  expect(libraryOpened(at(PLUGINS_LESSON_STEP, { library: true }))).toBeUndefined()
})

test("the lesson's plugin advances the librarian lesson; another plugin does not", () => {
  const guide = at(LIBRARIAN_LESSON_STEP, { library: true })
  expect(pluginInstalled(guide, LESSON_PLUGIN)?.step).toBe(LIBRARIAN_LESSON_STEP + 1)
  expect(pluginInstalled(guide, LESSON_PLUGIN)?.librarian).toBe(true)
  expect(pluginInstalled(guide, "dispatcher")).toBeUndefined()
  expect(pluginInstalled(at(LIBRARIAN_LESSON_STEP), LESSON_PLUGIN)).toBeUndefined()
})
