import { LESSON_PLUGIN, libraryOpened, pluginInstalled } from "../../onboarding/pluginLesson"
import { initialGuide } from "../AppState"
import type { GuideState } from "../AppState"
import type { ControllerContext } from "./context"

/** Durable, replayable onboarding. Practice artifacts never enter repository/run tables. */
export function createGuideController(ctx: ControllerContext) {
  const guideAct = async (action: string, value = ""): Promise<string | void> => {
    const guide: GuideState = { ...(ctx.store.session().guide ?? initialGuide()) }
    switch (action) {
      case "next":
        if (guide.step === 3 && (guide.heard.trim() || guide.project.trim())) {
          guide.responseId ??= crypto.randomUUID()
          await ctx.store.dispatch({ type: "guide.changed", actor: ctx.commandActor, guide }).isPersisted.promise
          try {
            const response = await ctx.rawHttp("https://bug.smithers.sh/api/onboarding-answers", {
              method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify({ id: guide.responseId, heard: guide.heard, project: guide.project }),
              signal: AbortSignal.timeout(15000),
            })
            if (!response.ok || (await response.json() as { saved?: boolean }).saved !== true)
              return "Your answers could not be saved. Please try again."
          } catch { return "Your answers could not be saved. Please try again." }
        }
        if ([1, 6, 7, 8, 11, 13].includes(guide.step)) return "Complete this lesson's action first."
        guide.step = Math.min(14, guide.step + 1)
        if (guide.step === 6) guide.conversationOpen = false
        break
      case "back":
        guide.step = Math.max(0, guide.step - 1)
        break
      case "restart": {
        const playthrough = (guide.playthrough ?? 0) + 1
        delete guide.acceptedPracticeTitle
        delete guide.responseId
        delete guide.demoRun
        Object.assign(guide, initialGuide(), { playthrough })
        break
      }
      case "open":
        guide.conversationOpen = true
        if (guide.step === 6) guide.step = 7
        break
      case "close":
        guide.conversationOpen = false
        break
      case "toggle":
        guide.conversationOpen = !guide.conversationOpen
        if (guide.step === 6 && guide.conversationOpen) guide.step = 7
        break
      case "heard":
        guide.heard = value.slice(0, 500)
        break
      case "project":
        guide.project = value.slice(0, 500)
        break
      case "title":
        delete guide.acceptedPracticeTitle
        guide.prototypeTitle = value.slice(0, 100)
        break
      case "sound":
        guide.sound = !guide.sound
        break
      case "wait-flow": {
        if (guide.step !== 4) return "Run this example in the flows lesson."
        if (guide.demoRun?.status === "running") return
        const id = crypto.randomUUID()
        const key = `guide-flow-${id}`
        ctx.store.dispatch({ type: "toast.shown", actor: "system", key, title: "Waiting 5 seconds…" })
        guide.demoRun = { id, status: "running", startedAt: Date.now() }
        await ctx.store.dispatch({ type: "guide.changed", actor: ctx.commandActor, guide }).isPersisted.promise
        await new Promise<void>(resolve => setTimeout(resolve, 5000))
        const latest = ctx.store.session().guide
        if (latest?.demoRun?.id !== id) {
          ctx.store.dispatch({ type: "toast.resolved", actor: "system", key, status: "failed", title: "Stopped", detail: "" })
          return
        }
        ctx.store.dispatch({ type: "toast.resolved", actor: "system", key, status: "ok", title: "Done", detail: "" })
        await ctx.store.dispatch({ type: "guide.changed", actor: ctx.commandActor, guide: {
          ...latest, demoRun: { ...latest.demoRun, status: "succeeded", finishedAt: Date.now() },
        } }).isPersisted.promise
        return
      }
      case "notify": {
        /* Every press sends its own notification — a fresh key per press, not the shared slot. */
        const key = `guide-hello-${crypto.randomUUID()}`
        ctx.store.dispatch({
          type: "toast.shown",
          actor: "system",
          key,
          title: "A little hello from Smithers",
        })
        ctx.store.dispatch({
          type: "toast.resolved",
          actor: "system",
          key,
          status: "ok",
          title: "You can keep working",
          detail: "This is a tutorial notification. I'll bring real flow updates here too.",
        })
        break
      }
      case "dark": {
        /*
         * One press, both themes: flip, hold so the change is seen, then
         * restore the theme the session started in. The lesson advances at
         * once; the return lands while the next message arrives.
         */
        if (guide.step !== 1) return "This theme demonstration belongs to its lesson."
        const before = ctx.store.session().theme
        const flipped = before === "dark" ? "light" as const : "dark" as const
        ctx.store.dispatch({ type: "theme.changed", actor: "system", theme: flipped })
        guide.step = 2
        await ctx.store.dispatch({ type: "guide.changed", actor: ctx.commandActor, guide }).isPersisted.promise
        await new Promise<void>(resolve => setTimeout(resolve, 1500))
        /* A theme the user chose during the demo is theirs; never stomp it. */
        if (ctx.store.session().theme === flipped)
          ctx.store.dispatch({ type: "theme.changed", actor: "system", theme: before })
        return
      }
      /*
       * The two plugin lessons are finished by the REAL flows — `/plugins`
       * opens the Library and `/plugins.install librarian` installs from it,
       * and the plugins controller advances the lesson through the same two
       * helpers used here. These actions stay as the older door onto the same
       * transition; both read one definition so they cannot drift.
       */
      case "library": {
        const opened = libraryOpened(guide)
        if (opened === undefined) return "Meet the Library in the plugin lesson."
        Object.assign(guide, opened)
        break
      }
      case "librarian": {
        const added = pluginInstalled(guide, LESSON_PLUGIN)
        if (added === undefined) return "Open the Library first."
        /* The lesson installs for real; the shelf is the workspace's, not the tutorial's. */
        ctx.store.dispatch({ type: "plugin.installed", actor: ctx.commandActor, plugin: LESSON_PLUGIN })
        Object.assign(guide, added)
        break
      }
      case "revise":
        if (guide.step !== 11 || !guide.prototypeTitle.trim()) return "Give the prototype a title first."
        guide.revised = true
        guide.step = 12
        break
      case "request-changes":
        if (guide.step !== 13) return "Open the practice review first."
        delete guide.acceptedPracticeTitle
        guide.revised = false
        guide.step = 11
        break
      case "accept-practice":
        if (guide.step !== 13 || !guide.revised) return "Review your practice change first."
        guide.acceptedPracticeTitle = guide.prototypeTitle
        guide.step = 14
        guide.conversationOpen = false
        break
      case "finish":
        guide.step = 14
        guide.conversationOpen = false
        break
      default:
        return `Unknown onboarding action: ${action}`
    }
    await ctx.store.dispatch({ type: "guide.changed", actor: ctx.commandActor, guide }).isPersisted.promise
  }
  return { guideAct }
}
