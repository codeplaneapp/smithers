/*
 * The two lessons the plugin shelf owns, and what they advance on.
 *
 * The guided introduction teaches plugins with the REAL flows: the lesson is
 * finished by typing `/plugins` and by installing a plugin from the Library,
 * not by a tutorial-only button. So the plugins controller has to know which
 * lesson a person is standing in, and the guide controller has to agree with
 * it — this module is the one place that decides, and both read it.
 *
 * The step numbers are derived from the lesson copy rather than written down,
 * because lessons get inserted and removed; a renumbering must not silently
 * point these at the wrong lesson. `pluginLesson.test.ts` pins that both
 * lessons are still found and still adjacent.
 */
import { GUIDE_LESSONS } from "./lessons"
import type { GuideState } from "../state/AppState"

/** The lesson that asks the reader to type `/plugins`. */
export const PLUGINS_LESSON_STEP = GUIDE_LESSONS.findIndex((lesson) => lesson.includes("/plugins"))

/** The lesson that asks the reader to install the Librarian from the Library. */
export const LIBRARIAN_LESSON_STEP = GUIDE_LESSONS.findIndex((lesson) => lesson.startsWith("The Librarian"))

/** The plugin the librarian lesson installs; installing it finishes the lesson. */
export const LESSON_PLUGIN = "librarian"

/**
 * The guide after the Library was opened during its lesson, or undefined when
 * the reader is somewhere else and the flow is just a flow.
 */
export const libraryOpened = (guide: GuideState): GuideState | undefined =>
  guide.step === PLUGINS_LESSON_STEP && !guide.library
    ? { ...guide, library: true, step: guide.step + 1, conversationOpen: false }
    : undefined

/** The guide after the lesson's plugin was installed, or undefined otherwise. */
export const pluginInstalled = (guide: GuideState, id: string): GuideState | undefined =>
  id === LESSON_PLUGIN && guide.step === LIBRARIAN_LESSON_STEP && guide.library && !guide.librarian
    ? { ...guide, librarian: true, step: guide.step + 1 }
    : undefined
